# Design Spec — Codebase Memory (Codegraph): Structured Code Index for Recall

| Field | Value |
|---|---|
| Doc version | 0.1 (Draft — awaiting owner approval before coding) |
| Date | 2026-07-15 |
| Status | Proposed / direction-setting — no code in this change |
| Feature name | "memory codebase" → **Codegraph Memory** |
| Origin | Owner request: memory should store a codegraph of the system — what functions a file contains, where a function is defined (file:line), and where it is called (caller/callee) |
| Relation to existing surface | New tool family `codegraph_*`, sits alongside `memory_*` (free-text facts) and `reasoning_*` (investigation narrative) |

---

## 1. Bối cảnh & động cơ

Server hiện tại lưu hai loại tri thức, cả hai đều là **văn bản tự do**:

- `memory_*` — facts, preferences, decisions, reasoning summaries (bảng `memories`, `src/tools/memory.ts`).
- `reasoning_*` — narrative điều tra dạng `thought`/`action`/`observation` (bảng `reasoning_steps`, `src/tools/reasoning.ts`).

Không layer nào có **liên kết có cấu trúc tới mã nguồn**: không lưu file path, symbol, line range, hay quan hệ gọi giữa các hàm. Khảo sát toàn repo xác nhận **chưa có** code ingestion / indexing / codegraph nào — không có khái niệm file, symbol, chunk, hay AST. Retrieval hoàn toàn là **SQLite FTS5 + BM25** (`memories_fts` tại `src/migrations/0001_initial.ts:23-45`), không embeddings.

Khi agent làm việc trong một repo lớn, các câu hỏi lặp đi lặp lại tốn nhiều lượt tìm kiếm:

- "File này có những hàm/lớp nào?"
- "Hàm `X` định nghĩa ở đâu?" (file + dòng)
- "Hàm `X` được gọi ở đâu?" (danh sách caller)
- "Hàm `X` gọi những gì?" (callee)

Codegraph Memory lưu những dữ kiện này ở dạng **có cấu trúc, truy vấn được**, để agent recall trực tiếp thay vì quét lại repo mỗi lần.

## 2. Goals / Non-goals

### Goals

- **G1** — Truy vấn "file → symbols": liệt kê hàm/lớp trong một file kèm kind và line range.
- **G2** — Truy vấn "symbol → định nghĩa": tên hàm → nơi định nghĩa (`file:start_line-end_line`, signature).
- **G3** — Truy vấn "symbol → callers/callees": quan hệ gọi hai chiều, kèm vị trí `file:line` của mỗi lời gọi.
- **G4** — Scoping theo workspace: codegraph của repo hiện tại không lẫn với repo khác.
- **G5** — Idempotent re-index theo từng file: ghi lại một file thay thế sạch dữ liệu cũ của file đó, không sinh trùng lặp.
- **G6** — Zero new dependency: giữ đúng kỷ luật repo (chỉ `@modelcontextprotocol/sdk` + `zod`).

### Non-goals (đề xuất — chờ owner chốt)

- **Server không tự parse mã nguồn.** Không nhúng tree-sitter / parser / AST vào server (vi phạm G6 và kỷ luật "no new dependency"). Dữ liệu symbol/edge do **agent hoặc một indexer bên ngoài** cung cấp ở dạng đã phân tích. Xem §6 cho open question về nguồn dữ liệu.
- **Không embeddings / semantic search.** Retrieval là tra cứu có cấu trúc + FTS5, nhất quán với mọi wave trước.
- **Không phân tích liên-repo / call graph toàn cục xuyên workspace** ở v1.
- **Không thay đổi `memory_*` / `reasoning_*`.** Codegraph là họ tool độc lập.

## 3. Mô hình dữ liệu (đề xuất)

Tái dùng khuôn mẫu FTS5 external-content + trigger sync đã có (`src/migrations/0001_initial.ts:23-45`, `src/migrations/0003_reasoning_steps_fts.ts`). Migration mới `0006_codegraph.ts`.

### 3.1. `code_symbols`

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | TEXT PK | `sym_<uuid>` (theo mẫu `newId`) |
| `workspace` | TEXT NOT NULL | `getWorkspace()` tại thời điểm ghi |
| `file_path` | TEXT NOT NULL | tương đối theo workspace root |
| `symbol_name` | TEXT NOT NULL | tên hàm/lớp/… |
| `symbol_kind` | TEXT NOT NULL | CHECK IN (`function`,`method`,`class`,`interface`,`type`,`variable`,`module`) |
| `signature` | TEXT | chữ ký/đầu khai báo, optional |
| `container` | TEXT | symbol cha (vd class của một method), optional |
| `start_line` | INTEGER NOT NULL | 1-based |
| `end_line` | INTEGER NOT NULL | 1-based |
| `language` | TEXT | vd `typescript`, optional |
| `created_at` | TEXT NOT NULL | `nowIso()` |
| `updated_at` | TEXT NOT NULL | `nowIso()` |

Index: `(workspace, file_path)`, `(workspace, symbol_name)`, `(workspace, symbol_kind)`.

### 3.2. `code_edges`

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | TEXT PK | `edge_<uuid>` |
| `workspace` | TEXT NOT NULL | như trên |
| `caller_symbol_id` | TEXT NOT NULL | FK → `code_symbols(id)` ON DELETE CASCADE |
| `callee_symbol_id` | TEXT | FK → `code_symbols(id)`; NULL nếu chưa resolve (callee ngoài repo hoặc chưa index) |
| `callee_name` | TEXT NOT NULL | tên callee dạng text — luôn lưu để resolve lại được sau |
| `edge_kind` | TEXT NOT NULL | CHECK IN (`calls`,`imports`,`references`,`extends`,`implements`) |
| `file_path` | TEXT NOT NULL | nơi xảy ra lời gọi |
| `line` | INTEGER NOT NULL | dòng của lời gọi |
| `created_at` | TEXT NOT NULL | `nowIso()` |

Index: `(caller_symbol_id)`, `(callee_symbol_id)`, `(workspace, callee_name)`.

### 3.3. `code_symbols_fts`

FTS5 external-content trên `symbol_name` + `signature` + `file_path`, `content='code_symbols'`, `content_rowid='rowid'`; 3 trigger (AI/AD/AU) đồng bộ như `0003`, và backfill `('rebuild')` khi tạo. Dùng cho tra cứu mờ theo tên/chữ ký (`codegraph_search`). Sanitize truy vấn bằng `toFtsQuery` (`src/utils.ts:34-69`).

## 4. Tool surface (họ `codegraph_*`)

Đăng ký qua `registerCodegraphTools(server, database?)` trong `src/server.ts` cạnh `registerMemoryTools`, mỗi handler bọc `withTelemetry` (thêm `operation_type` mới cho codegraph vào CHECK của `tool_usage_events`, hoặc tái dùng nhãn phù hợp — quyết định khi code).

| Tool | Access | Mô tả |
|---|---|---|
| `codegraph_record` | write | Batch upsert symbols + edges cho **một file**; xoá sạch symbol/edge cũ của `file_path` đó trước khi ghi (idempotent re-index). |
| `codegraph_file_symbols` | read | `file_path` → danh sách symbol + kind + line range. (G1) |
| `codegraph_find_symbol` | read | `symbol_name` → nơi định nghĩa (`file:line`, signature, container). (G2) |
| `codegraph_find_references` / `codegraph_callers` | read | symbol → các edge có nó là callee → caller kèm `file:line`. (G3 — "gọi ở đâu") |
| `codegraph_callees` | read | symbol → những gì nó gọi. (G3 — chiều ngược) |
| `codegraph_search` | read | FTS trên tên/chữ ký, xếp hạng BM25 (theo mẫu `src/tools/memory.ts:363-378`). |

Schema input đặt ở `src/schemas/codegraph.ts`, dùng `.strict()` nhất quán với `src/schemas/memory.ts`.

## 5. Workspace scoping

Khác với `memory_*` — nơi workspace là **soft ranking signal** (ưu tiên khi hoà, không lọc cứng; `src/tools/reasoning.ts:250-325`) — codegraph nên dùng **hard filter theo workspace**: mọi truy vấn `codegraph_*` chỉ trả về symbol/edge có `workspace = getWorkspace()`. Lý do: call graph của một repo khác là nhiễu thuần tuý, không có giá trị recall xuyên dự án. Tái dùng `getWorkspace()` (`src/constants.ts:49-51`).

## 6. Nguồn dữ liệu — open question chính (cần owner định hướng)

Ai điền dữ liệu vào codegraph?

- **(a) Agent tự phân tích rồi gọi `codegraph_record`.** Server thuần lưu trữ, language-agnostic, zero dependency. Agent (vốn đã đọc code) trích symbol/edge và đẩy vào. **Khuyến nghị cho v1.**
- **(b) Bổ sung một CLI subcommand indexer** (kiểu `install-agents` tại `src/index.ts`) tự quét repo và populate. Mạnh hơn nhưng cần parser → thêm dependency, lệch kỷ luật repo. **Để ngỏ cho sau.**

Spec đề xuất chốt (a) cho v1; (b) là hướng mở rộng.

## 7. Staleness / invalidation

- Re-index theo file: `codegraph_record` cho một `file_path` xoá toàn bộ symbol (+ edge CASCADE) cũ của file rồi ghi mới → dữ liệu file luôn phản ánh lần index gần nhất.
- Hệ quả cần lưu ý: khi symbol bị xoá, các `code_edges` từ file **khác** trỏ tới nó qua `callee_symbol_id` sẽ mất liên kết. Vì luôn giữ `callee_name`, có thể **resolve lại** callee theo tên ở lần index sau. Chi tiết chiến lược resolve (lazy khi query hay eager khi record) quyết định lúc code.
- v1 không tự phát hiện file đã đổi trên đĩa; việc gọi lại `codegraph_record` là trách nhiệm của agent/indexer.

## 8. Alternatives đã cân nhắc & rejected

- **Embeddings / vector search** — loại: thêm dependency nặng, lệch kỷ luật "no new dependency"; câu hỏi của owner là quan hệ có cấu trúc (định nghĩa/caller/callee), không phải tương đồng ngữ nghĩa.
- **Nhét vào bảng `memories` qua `metadata`** — loại: `metadata` là JSON text, không truy vấn quan hệ caller/callee hiệu quả; không có chỉ mục cho "ai gọi hàm này".
- **Server tự parse mã nguồn (tree-sitter)** — hoãn: mạnh nhưng vi phạm G6; đặt ở hướng (b) của §6.

## 9. Kế hoạch triển khai phác thảo (cho phiên sau)

Chỉ liệt kê — **không thực hiện trong change này**:

1. Migration `src/migrations/0006_codegraph.ts` (2 bảng + FTS5 + trigger), đăng ký vào `src/migrations/index.ts`.
2. Cập nhật assertion danh sách version có thứ tự ở `src/__tests__/migrations.test.ts` và `src/__tests__/reasoning-audit-tools.test.ts`.
3. `src/schemas/codegraph.ts` — input contracts.
4. `src/tools/codegraph.ts` — `registerCodegraphTools`, mỗi tool bọc `withTelemetry`.
5. 1 dòng đăng ký trong `src/server.ts`.
6. Test `src/__tests__/codegraph-tools.test.ts` theo mẫu harness của `memory-tools.test.ts`.
7. Bump `MCP_VERSION` (`src/constants.ts`) + `package.json` + `docs/architecture.md` `Version:` + `CHANGELOG.md`, cập nhật bảng tool trong `README.md` và storage model trong `docs/architecture.md` (theo Release Process trong `CLAUDE.md`).

## 10. Open questions cho owner

1. Nguồn dữ liệu: chốt hướng (a) hay muốn cả (b)? (§6)
2. `edge_kind` cần đủ 5 giá trị (`calls/imports/references/extends/implements`) hay v1 chỉ cần `calls`?
3. Có cần `codegraph_delete` / `codegraph_clear_workspace` để dọn index cũ không?
4. Release version mục tiêu khi triển khai (điền vào roadmap sau khi duyệt spec).
