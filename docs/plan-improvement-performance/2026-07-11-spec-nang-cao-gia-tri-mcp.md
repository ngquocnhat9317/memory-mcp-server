# SPEC — Nâng cao giá trị Memory MCP (Wave 3: "Recall đúng hơn, đáng tin hơn, đến sớm hơn")

| Trường | Giá trị |
|---|---|
| Phiên bản tài liệu | 0.3 (Draft — lịch sử sửa đổi ở §13) |
| Ngày | 2026-07-11 |
| Phiên bản MCP hiện tại | 1.2.5 (`src/constants.ts:6`) |
| Phiên bản MCP mục tiêu | 1.3.0 (Wave 3) |
| Định hướng kế tiếp | 1.4.0 (Wave 4 — ứng viên có điều kiện, chỉ khởi động sau evidence gate §9.3) |
| Người soạn | Claude (theo brief định vị của owner) |
| Phạm vi | Wave 3 (v1.3.0): WI-1..3 code + WI-4..5 docs/growth · Wave 4 (v1.4.0): WI-6, WI-7 — ứng viên sau gate (§9) |

---

## 1. Bối cảnh và triết lý định hướng

Sản phẩm đã đi qua hai Wave: Wave 1 đóng vòng giá trị memory (auto-recall, `used_memory_ids`, TTL session), Wave 2 hoàn thiện batch steps, lifecycle guide và README định vị lại. Định vị hiện tại với người dùng gói trong một câu:

> **"Trí nhớ tự vận hành: agent của bạn nhớ được việc cũ mà không cần ai nhắc, và bạn không phải bảo trì gì cả."**

Gốc của định vị này là bài học từ dữ liệu thật: **hành vi đúng phải là hành vi mặc định**. Server tự mở tủ hồ sơ đúng lúc (auto-recall khi mở session), tự dọn (TTL), tự hỏi "cái này có giúp ích không" vào khoảnh khắc agent chắc chắn có mặt (`used_memory_ids` lúc đóng task). Không đặt cược vào kỷ luật của agent.

Giá trị cảm nhận của toàn hệ thống quy về một phân số:

```
                    số lần recall hữu ích
Giá trị cảm nhận = ─────────────────────────────
                    công sức bỏ ra + nhiễu phải chịu
```

Mọi hạng mục trong spec này đều phải trả lời được câu hỏi lọc duy nhất: **"Việc này có làm lần recall hữu ích kế tiếp đến sớm hơn, đúng hơn, hay đáng tin hơn không?"** Hạng mục nào không trả lời được thì bị loại (xem §8 — Cân nhắc nhưng không làm).

---

## 2. Mục tiêu và ngoài phạm vi

### 2.1. Mục tiêu (goals)

- **G1 — Recall đúng hơn (tăng tử số):** khi kho memory lớn lên (hàng trăm bản ghi), memory *khớp nhất với ngữ cảnh task* phải đứng trên memory "importance cao nhưng lạc đề". Nhiễu trong recall tệ hơn không recall — nó dạy agent lờ tính năng đi.
- **G2 — Recall đáng tin hơn:** memory được recall phải cho thấy *nó từ đâu ra*, để agent (và người dùng đọc transcript) phân biệt "kết luận có xuất xứ, lần theo được trace" với "một câu văn trôi nổi".
- **G3 — Vòng feedback giá trị hoạt động ở cấu hình mặc định:** tín hiệu "memory này thực sự giúp ích" (`used_memory_ids`) phải được ghi nhận trên mọi bản cài, không phụ thuộc cấu hình tùy chọn.
- **G4 — Rút ngắn time-to-first-value:** người dùng mới phải chạm khoảnh khắc "ơ, nó nhớ này" trong tuần đầu — trước khi họ kịp gỡ.
- **G5 — Lời nói khớp sản phẩm:** mọi kênh phát hành (README, registry submissions) dùng cùng một câu định vị "it just remembers".

### 2.2. Ngoài phạm vi (non-goals)

- **Không thêm dependency mới.** Mọi thay đổi ranking dùng năng lực FTS5 có sẵn của `node:sqlite`. Không embeddings, không vector search, không service ngoài.
- **Không thêm biến cấu hình mới** trừ khi bắt buộc — triết lý là zero-config, hành vi đúng là mặc định.
- **Không xây cơ chế chống thoái hoá kho (memory decay/expiry)** — chưa có bằng chứng cần (bài học 13 tool ế: đừng xây trước nhu cầu).
- **Không đổi tool surface** — không thêm/bớt tool nào; chỉ làm giàu output của tool hiện có.
- **Không đụng đến hành vi cloud/network** — sản phẩm vẫn 100% local, một file SQLite.

---

## 3. Hiện trạng kỹ thuật (đã xác minh trên code, nhánh `feat/improve-README` @ `278d53f`)

| # | Phát hiện | Bằng chứng |
|---|---|---|
| HT-1 | **Auto-recall không xếp theo độ khớp.** `recallRelatedMemories` match OR từng từ của title (fuzzy), rồi `ORDER BY m.importance DESC, m.updated_at DESC` — độ khớp FTS bị bỏ hoàn toàn khỏi thứ tự. | `src/tools/reasoning.ts:248-254`; `toFtsOrQuery` tại `src/utils.ts:41-44`; `AUTO_RECALL_LIMIT` mặc định 3 tại `src/constants.ts:23-25` |
| HT-2 | **`memory_search` cũng xếp theo importance, không theo relevance**, dù mô tả tool nói "ranked by relevance". Search dùng AND-match (`toFtsQuery`) nên hậu quả nhẹ hơn auto-recall, nhưng cùng một khiếm khuyết. | `src/tools/memory.ts:333-351` |
| HT-3 | **FTS5 đã sẵn sàng cho relevance ranking.** Bảng `memories_fts` là FTS5 external-content (columns `content`, `tags`) — hàm `bm25()`/cột `rank` có sẵn, hiện chưa dùng. | `src/migrations/0001_initial.ts:23-28` |
| HT-4 | **Nguồn gốc memory đã được lưu nhưng không được surface.** Khi `reasoning_complete_session` persist kết luận, metadata đã ghi `source_session_id`, `session_title`, `step_count`. Nhưng record trả về trong `related_memories` chỉ có `id/type/importance/tags/snippet` — mất xuất xứ. (`memory_search`/`memory_get` trả full record nên đã có metadata — chỉ auto-recall thiếu.) | Ghi: `src/tools/reasoning.ts:1406-1411`. Mất khi surface: `src/tools/reasoning.ts:261-267`. Search trả đủ: `src/tools/memory.ts:40-52` |
| HT-5 | **[Phát hiện mới, ngoài brief] Vòng feedback `used_memory_ids` chết ở cấu hình mặc định.** `recordToolUsageEvent` trả `null` ngay khi `TELEMETRY_ENABLED` off (`if (!TELEMETRY_ENABLED) return null;`), và telemetry mặc định off từ commit `278d53f`. Hệ quả: agent báo "memory X đã giúp ích" lúc đóng session → server chỉ trả warning "Telemetry is disabled; usage feedback ... was not recorded" và vứt tín hiệu. Tín hiệu sản phẩm cốt lõi (đo tử số của phân số giá trị) đang bị nhốt chung cửa với analytics tùy chọn. | Gate: `src/tools/telemetry.ts:89`; default off: `src/constants.ts:8`; warning: `src/tools/reasoning.ts:1446-1448` |
| HT-6 | **Có cổng telemetry THỨ HAI, độc lập, mà một sửa đổi ở `recordToolUsageEvent` không chạm tới.** Tool `memory_record_usage_feedback` tự kiểm `telemetryPersistenceEnabled()` (một hàm riêng đọc thẳng `process.env.MEMORY_TELEMETRY`) ngay trong handler và trả `recorded:false` nếu off — hoàn toàn tách khỏi gate của `recordToolUsageEvent`. Mô tả tool cũng hard-code "Requires MEMORY_TELEMETRY=on". Ngoài ra tool này ghi event qua wrapper `withTelemetry` (operationType `"feedback"`) chứ không gọi `recordToolUsageEvent` trực tiếp — nên nếu chỉ ung-gate `recordToolUsageEvent`, event *sẽ* được ghi trong khi handler vẫn báo `recorded:false`, tạo mâu thuẫn giữa dữ liệu và phản hồi tool. | Cổng 2: `src/tools/memory.ts:1313`; hàm: `src/tools/memory.ts:95-97`; mô tả tool: `src/tools/memory.ts:1230`; wrapper ghi: `src/tools/telemetry.ts:159` + `src/tools/memory.ts:1243` |

**Diễn giải tác động của HT-1** (vì đây là hạng mục lõi): với kho ~10 memory thì importance-first vô hại. Nhưng OR-match nghĩa là title "Fix checkout timeout in payment service" sẽ match *mọi* memory chứa từ "fix" hoặc "service". Ở kho 500 memory, ba slot recall (limit 3) sẽ bị chiếm bởi ba memory importance-5 bất kỳ có dính một từ phổ biến — memory importance-3 nhưng khớp cả "checkout" lẫn "timeout" không bao giờ lên được. Người dùng gắn bó càng lâu, recall càng loãng — đường cong giá trị đảo ngược đúng lúc lẽ ra nó phải tăng.

---

## 4. Hạng mục công việc

### WI-1 — Xếp hạng recall theo BM25 relevance (P1 — lõi của Wave 3)

**Trả lời câu hỏi lọc:** làm lần recall kế tiếp **đúng hơn**.

**Mô tả.** Đưa độ khớp FTS5 (`rank` = BM25, giá trị càng nhỏ càng khớp) thành tiêu chí xếp hạng chính cho cả auto-recall (`recallRelatedMemories`) và `memory_search`; `importance` và `updated_at` trở thành tiêu chí phụ (tie-break).

**Thiết kế.** Thay subquery `rowid IN (...)` bằng JOIN để lấy được cột `rank`:

```sql
-- recallRelatedMemories (src/tools/reasoning.ts)
SELECT m.id, m.type, m.content, m.tags, m.importance
FROM memories m
JOIN (
  SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?
) f ON m.rowid = f.rowid
ORDER BY f.rank ASC, m.importance DESC, m.updated_at DESC
LIMIT ?
```

`memory_search` áp cùng pattern nhưng **cần lắp ráp cẩn thận hơn**: query hiện tại nối thêm `tagClause` (điều kiện lọc tag dạng subquery) vào mệnh đề `WHERE` (`src/tools/memory.ts:349`). Khi chuyển sang JOIN với FTS để lấy `rank`, phải giữ nguyên `tagClause` + filter `type`/`agent_id` và đặt `ORDER BY rank` sau cùng — không phải copy y hệt query của `recallRelatedMemories`. Không thêm biến cấu hình — relevance-first là hành vi mặc định mới, đúng triết lý.

**Yêu cầu chức năng:**
- FR-1.1: Auto-recall xếp theo `rank ASC` trước, `importance DESC`, `updated_at DESC` sau.
- FR-1.2: `memory_search` xếp cùng quy tắc; mô tả tool ("ranked by relevance") trở thành đúng sự thật.
- FR-1.3: Hành vi lỗi giữ nguyên — recall là best-effort, FTS query hỏng không được chặn việc tạo session (giữ khối `try/catch` tại `src/tools/reasoning.ts:268-271`).
- FR-1.4: Không đổi shape của response — chỉ đổi thứ tự phần tử.

**Tiêu chí nghiệm thu:**
- AC-1.1: Kho có memory A (importance 5, khớp 1 từ của title) và memory B (importance 3, khớp 3 từ) → B đứng trên A trong `related_memories`. *Lưu ý test:* BM25 phụ thuộc term-frequency, IDF và độ dài doc, nên "khớp nhiều từ hơn ⇒ rank cao hơn" chỉ đúng theo hướng, không tuyệt đối — test phải dùng **fixture tách biệt có chủ đích** (chênh lệch số term khớp đủ lớn, độ dài content tương đương) để tránh flaky, không dùng dữ liệu tuỳ ý.
- AC-1.2: Hai memory cùng độ khớp → memory importance cao hơn đứng trên; cùng importance → memory mới hơn đứng trên.
- AC-1.3: Toàn bộ test hiện có pass sau khi cập nhật các assertion về thứ tự (đây là behavior change có chủ đích — cập nhật test cùng change, đúng quy tắc "Preserve tested behavior or update the tests together with the change" trong `CLAUDE.md`).

**Test plan:** thêm test relevance-ordering vào suite memory + reasoning (`src/__tests__/`); rà lại test nào đang khóa thứ tự importance-first và sửa cùng commit.

**File dự kiến chạm:** `src/tools/reasoning.ts`, `src/tools/memory.ts`, `src/__tests__/*`. Effort: **S** (1 buổi).

**Lưu ý kỹ thuật:** cột `rank` chỉ hợp lệ trong query có `MATCH` trên bảng FTS — vì vậy phải JOIN với subquery FTS thay vì kéo `rank` ra ngoài. Trọng số cột (ưu tiên `content` hơn `tags` qua `bm25(memories_fts, w1, w2)`) để mặc định ở bước này — xem OQ-1.

---

### WI-2 — Surface nguồn gốc (provenance) trong `related_memories` (P1)

**Trả lời câu hỏi lọc:** làm lần recall kế tiếp **đáng tin hơn**.

**Mô tả.** Metadata đã lưu sẵn xuất xứ khi kết luận được persist từ reasoning session (HT-4); chỉ cần đọc ra và gắn vào record trả về của auto-recall. Recall biến từ "một câu văn trôi nổi" thành "kết luận có xuất xứ" — và agent có thể lần theo trace (`reasoning_get_trace`) nếu cần kiểm chứng.

**Thiết kế.** Mở rộng interface `RelatedMemoryRecord` — lưu ý interface này định nghĩa **cục bộ trong `src/tools/reasoning.ts:215`**, không nằm ở `src/types.ts`, nên WI-2 không cần đụng `types.ts`. Hiện tại record trả về gồm `id/type/importance/tags/snippet` (`src/tools/reasoning.ts:261-267`); thêm một trường tùy chọn:

```ts
source?: {
  session_id: string;      // metadata.source_session_id
  session_title: string;   // metadata.session_title
  created_at: string;      // memories.created_at
}
```

`recallRelatedMemories` SELECT thêm `m.metadata, m.created_at`, parse bằng `parseJsonObject` có sẵn (`src/utils.ts:22`); chỉ gắn `source` khi metadata có đủ `source_session_id` + `session_title`. Memory lưu tay (không qua session) không có trường này — đúng ngữ nghĩa.

**Yêu cầu chức năng:**
- FR-2.1: Memory persist từ `reasoning_complete_session` khi được auto-recall phải kèm `source` với đủ 3 trường trên.
- FR-2.2: Memory không có provenance trong metadata → không có trường `source` (không trả `null` rỗng gây nhiễu).
- FR-2.3: Cập nhật description của `reasoning_start_session` để agent biết đọc trường `source` và có thể lần về trace bằng `reasoning_get_trace(source.session_id)`.
- FR-2.4: Metadata hỏng (JSON parse fail) → bỏ qua im lặng, không lỗi (tận dụng `parseJsonObject` đã trả `null` an toàn).

**Tiêu chí nghiệm thu:**
- AC-2.1: Flow end-to-end: session A complete với `save_as_memory=true` → mở session B có title liên quan → `related_memories[0].source.session_title` = title của A.
- AC-2.2: Memory tạo bằng `memory_save` thường → recall không có trường `source`.

**Test plan:** thêm case vào test reasoning lifecycle hiện có; giữ nguyên toàn bộ assertion cũ (đây là additive change).

**File dự kiến chạm:** `src/tools/reasoning.ts` (cả interface `RelatedMemoryRecord:215` lẫn `recallRelatedMemories`), `src/__tests__/*`. (Không đụng `src/types.ts` — interface là cục bộ.) Effort: **S** (nửa buổi).

---

### WI-3 — Tách usage-feedback khỏi cổng telemetry (P1 — nhỏ nhưng nền tảng)

**Trả lời câu hỏi lọc:** làm lần recall kế tiếp **đúng hơn về dài hạn** — không có tín hiệu "used" thì không bao giờ đo được tử số của phân số giá trị, và mọi quyết định tối ưu sau này đều mù.

**Vấn đề (HT-5).** `used_memory_ids` và `memory_record_usage_feedback` là **tín hiệu sản phẩm** (first-party, phục vụ chính vòng giá trị recall), nhưng đang bị ghi chung đường với **telemetry analytics** (opt-in, mặc định off). Ở bản cài mặc định, agent làm đúng nghi thức báo "memory này giúp ích" và server... vứt đi kèm một dòng warning. Đây là mâu thuẫn trực tiếp với triết lý "hành vi đúng phải là hành vi mặc định".

**Điểm cần làm rõ trước khi chọn thiết kế:** telemetry ở đây vốn cũng chỉ ghi vào bảng `tool_usage_events` trong file SQLite local — không có network. Lý do opt-in là minimal-footprint, không phải privacy-network. Vì vậy việc ghi *riêng phần feedback* ở mặc định không phá lời hứa "local và riêng tư"; cần nói rõ điều này trong docs.

**Thiết kế đề xuất (phương án tối thiểu — phải sửa CẢ HAI cổng, xem HT-5 và HT-6):**

*Cổng 1 — `recordToolUsageEvent` (`src/tools/telemetry.ts:89`):* cho phép ghi khi `operationType === "feedback"` bất kể `TELEMETRY_ENABLED`:

```ts
if (!TELEMETRY_ENABLED && event.operationType !== "feedback") return null;
```

*Cổng 2 — `telemetryPersistenceEnabled()` bên trong `memory_record_usage_feedback` (`src/tools/memory.ts:1313`):* đây là cổng **độc lập** mà sửa Cổng 1 không chạm tới. Phải cho tool này persist khi off (bỏ nhánh `recorded:false` do telemetry, giữ mọi validate khác), cập nhật lại `recorded`/warning tương ứng, và sửa mô tả tool ở `memory.ts:1230` (đang hard-code "Requires MEMORY_TELEMETRY=on"). Nếu bỏ qua cổng này, `memory_record_usage_feedback` vẫn báo `recorded:false` dù event đã bị wrapper ghi vào bảng — mâu thuẫn nêu ở HT-6.

Không migration mới, không bảng mới — feedback event vẫn nằm trong `tool_usage_events` với `operation_type='feedback'` như hiện tại; chỉ hai cái cổng đổi. Phương án thay thế (bảng `memory_feedback` riêng) bị loại vì footprint lớn hơn mà không thêm giá trị ở giai đoạn này.

**Yêu cầu chức năng:**
- FR-3.1: **[Cổng 1]** `reasoning_complete_session` với `used_memory_ids` ghi được feedback event khi telemetry off; warning "Telemetry is disabled..." (`src/tools/reasoning.ts:1446-1448`) bị gỡ bỏ.
- FR-3.2: **[Cổng 2]** `memory_record_usage_feedback` persist feedback và trả `recorded:true` khi telemetry off (sửa `telemetryPersistenceEnabled()` gate tại `src/tools/memory.ts:1313` + mô tả tool tại `memory.ts:1230`). Sau khi sửa, không còn đường nào ghi event feedback mà tool lại tự báo `recorded:false`.
- FR-3.3: **[Giới hạn cần nói rõ — xem §6]** Ung-gate feedback chỉ khôi phục **tử số** (số feedback `used`); các report `memory_usage_report`/`memory_adoption_report`/`memory_agent_scorecard` tính **mẫu số** (`memory_recalled`, `memory_searched`...) từ event của các tool khác, mà những event đó vẫn bị telemetry chặn khi off. Vì vậy WI-3 **không** làm các tỷ lệ này đo được ở bản mặc định — nó chỉ làm raw feedback count có thật. Rà lại message của các report để **không** hiểu nhầm "off vẫn có funnel đầy đủ"; nêu rõ trong output rằng tỷ lệ cần `MEMORY_TELEMETRY=on`. Quyết định có mở rộng ung-gate thêm event recall/search hay không: xem OQ-4.
- FR-3.4: Cập nhật `GUIDELINES.md` (bump `Version:` + sync assertion trong `src/__tests__/reasoning-audit-tools.test.ts`, theo quy tắc trong `CLAUDE.md`) và `README.md` mục telemetry: phân biệt rõ "usage feedback (luôn ghi, local)" và "usage telemetry (opt-in)".

**Tiêu chí nghiệm thu:**
- AC-3.1: Với `MEMORY_TELEMETRY` unset: complete session với `used_memory_ids=[X]` → trường output **`used_memory_feedback_recorded` = 1** (đúng tên trường tại `src/tools/reasoning.ts:1460`), và mảng `warnings` không còn dòng "Telemetry is disabled...".
- AC-3.2: Với `MEMORY_TELEMETRY` unset: `memory_record_usage_feedback` trả `recorded:true` và ghi được một row `operation_type='feedback'` vào `tool_usage_events`.
- AC-3.3: Với `MEMORY_TELEMETRY` unset: các event khác (search/save/reasoning start...) vẫn **không** được ghi — cổng telemetry cho phần analytics giữ nguyên.

**File dự kiến chạm:** `src/tools/telemetry.ts` (cổng 1), `src/tools/memory.ts` (cổng 2 tại `:1313`, mô tả tool tại `:1230`, report messages), `src/tools/reasoning.ts` (message), `GUIDELINES.md`, `README.md`, `CHANGELOG.md`, `src/__tests__/*`. Effort: **S→M** (hai cổng + rà report messages, nhiều hơn ước lượng ban đầu).

**Future enabler (ghi nhận, không làm ở Wave 3):** khi feedback tích lũy đủ, có thể boost ranking recall theo used-count — đã định hình thành **WI-6 của v1.4.0**, chỉ mở khóa bằng evidence gate. Xem §9. WI-3 chính là bước gieo dữ liệu cho gate đó: không có WI-3 thì 6 tháng nữa vẫn không có căn cứ để quyết định gì.

---

### WI-4 — Rút ngắn time-to-first-value cho người dùng mới (P2 — docs + 1 nudge in-product)

**Trả lời câu hỏi lọc:** làm lần recall hữu ích **đầu tiên** đến **sớm hơn** — mối đe doạ lớn nhất là cold start: kho rỗng tuần đầu → không có khoảnh khắc "ơ, nó nhớ này" → gỡ trước khi giá trị tích luỹ.

**Ba việc, xếp theo tác động:**

1. **Demo nhìn thấy được trước khi cài (README GIF/asciinema).** Kịch bản 2 cảnh: *Session 1* — agent debug xong, đóng session với `save_as_memory=true`; *Session 2* (giả lập hôm sau) — mở task liên quan, `related_memories` tự trồi kết luận cũ lên kèm nguồn gốc (ăn khớp WI-2 — quay demo **sau** khi WI-2 merge để khoe luôn provenance). Khoảnh khắc giá trị phải nhìn thấy được trước khi cài.
2. **AGENTS.md snippet là công cụ onboarding thật.** Snippet trong README phải khiến agent lưu kết luận ngay từ task đầu tiên (gieo hạt cho lần recall đầu). Rà lại snippet hiện có: bảo đảm nó chỉ dẫn rõ `save_as_memory=true` cho kết luận durable và `used_memory_ids` khi có memory giúp ích.
3. **Empty-store nudge (in-product, một dòng).** Khi `reasoning_start_session` trả `related_memories` rỗng **và** tổng số memory trong kho bằng 0, thêm một câu vào text response: *"No memories yet — when you complete this session, persist durable conclusions with save_as_memory=true so future sessions can recall them."* Điều kiện chặt (kho rỗng hoàn toàn) để nudge tự biến mất vĩnh viễn sau memory đầu tiên — không thành nhiễu (bảo vệ mẫu số).

**Tiêu chí nghiệm thu:**
- AC-4.1: README có demo section với GIF/recording thể hiện đúng kịch bản 2 cảnh. **[DEFERRED một phần — 2026-07-11]:** bản 1.3.0 ship với text walkthrough 2 cảnh trong README ("What it feels like"); asset GIF/asciinema cần owner tự quay phiên terminal thật (agent không quay được) — đúng dự liệu R6 (code release không chờ demo). Khi quay xong, thay/bổ sung vào cùng section.
- AC-4.2: Nudge chỉ xuất hiện khi kho rỗng; có test khóa hành vi này.

**File dự kiến chạm:** `README.md` (+ asset), `src/tools/reasoning.ts` (nudge, ~5 dòng), `src/__tests__/*`. Effort: **M** (chủ yếu là làm demo).

---

### WI-5 — Đồng bộ messaging trên mọi kênh (P3 — docs only)

**Mô tả.** README đã chuyển sang định vị "it just remembers". Rà `docs/growth/registry-submissions.md` và mọi mô tả đăng registry: dùng đúng câu định vị ở §1, dẫn cùng demo GIF của WI-4; loại bỏ mọi phần còn kể chuyện theo hướng "analytics/telemetry" như giá trị chính. Điểm khác biệt cạnh tranh nêu theo thứ tự: (1) tự recall không cần nhắc, (2) không phải bảo trì, (3) truy vết được suy luận — thứ đối thủ không có, (4) local & riêng tư (mạnh hơn sau khi telemetry thành opt-in).

**Tiêu chí nghiệm thu:** AC-5.1: `registry-submissions.md` và README dùng cùng một câu định vị; không kênh nào còn dẫn đầu bằng analytics.

**File dự kiến chạm:** `docs/growth/registry-submissions.md`, `README.md` (nếu lệch). Effort: **XS**.

---

## 5. Trình tự triển khai

```
Wave 3.1 — code, gộp release v1.3.0:
  WI-3 (ungate feedback)  →  WI-1 (BM25 ranking)  →  WI-2 (provenance)
Wave 3.2 — docs/growth, ngay sau khi 3.1 merge:
  WI-4 (demo + nudge)     →  WI-5 (messaging sync)
Wave 4 — v1.4.0, KHÔNG cam kết lịch:
  WI-6 (feedback-weighted ranking) — chỉ khởi động khi evidence gate §9.3 mở,
  sau khi v1.3.0 publish và kho memory người dùng đủ lớn qua sử dụng thật
```

Lý do thứ tự: WI-3 đi đầu vì nó là điều kiện để *đo* được tác động của WI-1/WI-2 về sau (không có tín hiệu "used" thì mọi tuyên bố cải thiện recall đều là cảm tính). WI-1 trước WI-2 vì cùng đụng `recallRelatedMemories` — làm ranking xong rồi mở rộng record đỡ conflict. WI-4 quay demo sau cùng để demo khoe được cả provenance. Mỗi WI một commit/PR riêng, diff nhỏ, theo quy tắc repo.

---

## 6. Chỉ số thành công

**Cảnh báo quan trọng về khả năng đo (sửa theo review):** các report (`memory_usage_report`/`memory_adoption_report`/`memory_agent_scorecard`) tổng hợp trên bảng `tool_usage_events`. WI-3 chỉ ung-gate **event feedback** — mọi event khác (auto-recall, search, save, reasoning) vẫn bị telemetry chặn khi off. Do đó **mẫu số** của phần lớn chỉ số bên dưới (số memory được recall, số lần search) **không** được ghi ở bản mặc định. Phải phân biệt rõ hai nhóm:

### 6.1. Đo được ở bản mặc định (`MEMORY_TELEMETRY` off) — chỉ nhờ WI-3

| Chỉ số | Định nghĩa | Kỳ vọng sau Wave 3 |
|---|---|---|
| Raw used-feedback count | số row `operation_type='feedback'`, `usefulness='used'` trong `tool_usage_events` | > 0 trong tuần đầu vận hành thật (bằng chứng vòng feedback sống lại) |
| Messaging consistency | các kênh phát hành dùng cùng câu định vị | Đạt/không đạt (WI-5) |

### 6.2. Cần bật `MEMORY_TELEMETRY=on` mới đo được (vì cần mẫu số từ event recall/search)

| Chỉ số | Định nghĩa | Phụ thuộc |
|---|---|---|
| Used-recall ratio | số feedback `used` / số memory được auto-recall | Cần event auto-recall (`memory_recalled`, `src/tools/memory.ts:940`) — telemetry-gated |
| Recall coverage | % session mở ra có `related_memories` không rỗng | Cần event `reasoning_start_session` với `related_memory_count` — telemetry-gated |
| Time-to-first-used | số ngày từ bản ghi memory đầu tiên đến feedback `used` đầu tiên | **Chưa có tool nào tính** — cần logic report mới; base cũng cần telemetry. Coi là hạng mục tương lai, không phải chỉ số sẵn sàng |

**Hệ quả (OQ-4 — đã chốt, xem §11 và §9.1):** ranh giới giữ nguyên theo khung "learning signal ≠ diagnostics" — không mở rộng ung-gate event auto-recall/search trong Wave 3. Chỉ §6.1 được coi là AC bắt buộc; §6.2 nghiệm thu bằng kịch bản test end-to-end (chạy với telemetry on trong CI), không phải bằng dữ liệu bản mặc định.

---

## 7. Rủi ro và giảm thiểu

| # | Rủi ro | Mức | Giảm thiểu |
|---|---|---|---|
| R1 | WI-1 đổi thứ tự recall → test hiện có khóa thứ tự importance-first sẽ fail | Cao (chắc chắn xảy ra) | Đây là behavior change có chủ đích: cập nhật test cùng commit, ghi rõ trong `CHANGELOG.md` |
| R2 | BM25 trên OR-query: title dài sinh nhiều term, term phổ biến ("fix", "the") làm loãng rank | Trung bình | BM25 bản chất đã phạt term phổ biến (IDF); giữ limit 3 + tie-break importance. Nếu vẫn nhiễu: cân nhắc trọng số cột (OQ-1) trước khi nghĩ đến stopword |
| R3 | Cột `rank` của FTS5 trong `node:sqlite` có sai khác giữa các version Node | Thấp `[UNVERIFIED]` | FTS5 đã dùng sẵn trong repo; viết test relevance chạy trong CI để tự xác minh trên version Node được support |
| R4 | WI-3 bị hiểu nhầm là "bật lại telemetry ngầm" | Trung bình (perception) | FR-3.4: docs phân biệt rõ feedback (local, phục vụ ranking/report của chính người dùng) với telemetry (opt-in); nhấn mạnh không có network trong cả hai |
| R5 | Scope creep — ranking boost theo usage, stopword, decay... "tiện tay làm luôn" | Trung bình | §8 là danh sách chặn tường minh; mỗi WI một PR, diff tối thiểu |
| R6 | Demo GIF (WI-4) tốn công hơn dự kiến, kéo trễ cả wave | Thấp | Wave 3.2 tách khỏi 3.1 — code release không chờ demo |

---

## 8. Cân nhắc nhưng KHÔNG làm (và lý do)

- **Semantic/vector search:** thêm dependency nặng, phá lời hứa "một file SQLite, zero-config". BM25 đủ tốt cho kho vài nghìn bản ghi.
- **Ranking boost theo used-count (trong Wave 3):** đúng hướng nhưng cần dữ liệu feedback tích lũy trước (WI-3 chính là bước gieo); làm bây giờ là xây trên số 0. → **Đã chuyển thành ứng viên WI-6 của v1.4.0**, chỉ mở khóa bằng evidence gate — xem §9.
- **Memory decay/TTL cho memory:** chưa có bằng chứng kho bị thoái hoá; GUIDELINES đã chặn đầu vào rác ("when in doubt, skip storage"). Đừng lặp lại bài học 13 tool ế.
- **Stopword filtering cho FTS:** chờ xem BM25 (vốn tự phạt term phổ biến) có đủ không đã.
- **Auto-recall cho `memory_search`:** search là hành vi chủ động, đã có ranking; không cần thêm cơ chế.
- **Config mới cho ranking (bật/tắt BM25):** hai chế độ ranking = gấp đôi surface phải test và giải thích, ngược triết lý default-đúng.

---

## 9. Định hướng v1.4.0 (Wave 4) — biến feedback thành nhiên liệu cho recall, mở khóa bằng bằng chứng

> **Trạng thái: ứng viên có điều kiện — KHÔNG phải backlog cam kết.** Wave 4 chỉ được khởi động sau khi v1.3.0 đã publish, người dùng đã tích lũy kho memory thực tế qua sử dụng, và evidence gate ở §9.3 mở. Nếu gate không mở, các hạng mục ở đây bị hủy hoặc thay bằng con đường rẻ hơn (nhánh fallback §9.3) — đó không phải thất bại, đó là spec hoạt động đúng thiết kế.

### 9.1. Khung đã chốt: learning signal ≠ diagnostics

Quyết định định khung (chốt cùng OQ-4, 2026-07-11): dữ liệu ghi vào `tool_usage_events` được phân loại theo **mục đích sử dụng**, không theo cơ chế ghi:

| Loại | Gồm | Chính sách | Lý do |
|---|---|---|---|
| **Learning signal** | usage-feedback (`used`/`ignored`/`stale`/`unsafe`) | **Luôn ghi**, local, mặc định (WI-3) | Là nhiên liệu cho recall — trả giá trị trực tiếp về cho user qua recall tốt hơn, không phải số liệu để ai đó đọc |
| **Diagnostics** | mọi event khác (search/save/recall/reasoning, latency, error_code, version breakdown) | **Opt-in** `MEMORY_TELEMETRY=on`, giữ nguyên | Công cụ chẩn đoán của owner; user thờ ơ với nó là bình thường |

Hệ quả thực dụng của khung này: **không đầu tư làm cho diagnostics "có giá trị với user"** — đó là đầu tư sai chỗ. Giá trị với user chỉ đi qua đúng một cửa: chất lượng recall. Câu hỏi "làm sao để user muốn bật telemetry" được trả lời bằng cách **làm cho họ không cần bật** — phần mang giá trị (feedback) đã luôn bật sẵn.

### 9.2. WI-6 (ứng viên) — Feedback-weighted ranking

**Bài toán.** BM25 (WI-1) đo *độ khớp văn bản* — "memory này nói về đúng chủ đề không?". Feedback `used` đo *độ hữu ích đã được chứng minh* — "memory này từng thực sự giúp trong task tương tự không?". Hai tín hiệu bổ sung nhau: kết hợp lại cho một recall **tự cải thiện theo thời gian sử dụng** — memory store tĩnh trở thành memory học được. Đây là bước nâng định vị từ "nhớ được" lên "càng dùng càng nhớ đúng cái cần".

**Phác thảo thiết kế** (chi tiết chỉ chốt khi gate mở):
- `used_count` = số event `operation_type='feedback'`, `usefulness='used'` theo `memory_id` trong `tool_usage_events` (dữ liệu tồn tại được là nhờ WI-3).
- `used_count` tham gia xếp hạng **sau** BM25 — dạng tie-break có trọng số hoặc boost **có trần**, không bao giờ thay thế relevance.
- **Chống rich-get-richer (ràng buộc bắt buộc):** boost phải có trần (ví dụ tương đương tối đa một bậc rank) và blend cùng recency — memory từng "hot" không được phép đè vĩnh viễn memory mới khớp hơn.
- Không dependency mới, không config mới — cùng kỷ luật với Wave 3.

**Ba rủi ro đã nhận diện khi review phản biện (giữ nguyên trong spec làm ràng buộc — chúng là lý do tồn tại của gate §9.3):**
1. **Nguồn tín hiệu phụ thuộc kỷ luật agent.** `used_memory_ids` là tham số tùy chọn do agent tự giác truyền — mâu thuẫn với triết lý "không đặt cược vào kỷ luật agent". Bằng chứng sống: một phiên làm việc tuân thủ GUIDELINES đầy đủ vẫn tạo ra 0 event feedback.
2. **Kho nhỏ làm boost vô hiệu.** Với kho vài chục–vài trăm memory, `used_count` đa số bằng 0 → tiêu chí này hầu như chỉ phá hòa, người dùng không cảm nhận khác biệt trong nhiều tháng đầu.
3. **Không có bộ eval thì mọi tinh chỉnh là đoán mò.** Không thể tuyên bố "ranking có feedback tốt hơn thuần BM25" nếu không có tập truy vấn + kỳ vọng thứ tự để so — điều kiện G-d bên dưới.

### 9.3. Evidence gate — điều kiện mở khóa WI-6

Đo sau **4–6 tuần** kể từ khi v1.3.0 được sử dụng thật (toàn bộ đọc từ `tool_usage_events` local — khả thi ở bản mặc định là nhờ WI-3):

| # | Điều kiện | Ngưỡng | Ý nghĩa |
|---|---|---|---|
| G-a | Tổng event `used` tích lũy | ≥ 20–30 | Có nhiên liệu tối thiểu cho flywheel |
| G-b | Số memory có `used_count ≥ 2` | ≥ 5 | Tín hiệu lặp lại thật, không phải nhiễu một lần |
| G-c | Còn phàn nàn/ghi nhận cụ thể về chất lượng recall dù BM25 (WI-1) đã chạy | Có bằng chứng cụ thể | Bài toán còn tồn tại sau khi giải pháp rẻ đã được thử |
| G-d | Bộ kịch bản eval nhỏ (≥ 10 truy vấn + kỳ vọng thứ tự) được viết **trước** khi chỉnh trọng số | Bắt buộc có | Không có thước đo thì không được phép tinh chỉnh |

**Cả bốn điều kiện cùng đạt → mở WI-6.** Thiếu bất kỳ điều kiện nào → không xây.

**Nhánh fallback — và là nhánh được kỳ vọng xảy ra:** nếu **G-a fail** (khả năng cao nhất, xem rủi ro 1 ở §9.2), bài toán thật là *tỷ lệ capture feedback*, không phải ranking. Hạng mục thay thế khi đó là **WI-6b — sửa guidance**: cập nhật `GUIDELINES.md` và AGENTS snippet trong README để agent nhớ truyền `used_memory_ids` khi đóng session (kèm bump version + sync test theo quy tắc repo). Chi phí bằng khoảng một phần trăm WI-6 và giải đúng chỗ nghẽn. Chỉ khi WI-6b đã chạy thêm một chu kỳ 4–6 tuần nữa mà G-a vẫn fail mới kết luận flywheel không khả thi với sản phẩm này.

### 9.4. WI-7 (ứng viên xa hơn) — Dọn kho theo bằng chứng

Ý tưởng: memory được recall nhiều lần nhưng luôn bị `ignored` hoặc bị đánh `stale` → ứng viên xóa rõ ràng, thay cho phỏng đoán. Đúng hướng, **nhưng có lỗ hổng ngầm đã nhận diện**: muốn biết "recall nhiều mà không được dùng" phải ghi được event recall (mẫu số) — thứ đang nằm bên ranh giới **diagnostics** (opt-in) theo khung §9.1. Tức WI-7 buộc mở lại quyết định ranh giới của OQ-4 một cách tường minh. Vì vậy: không gắn gate nào cho WI-7 ở bản này; chỉ xét khi WI-6 đã chạy thật và có nhu cầu dọn kho được ghi nhận cụ thể.

### 9.5. Wave 4 vẫn KHÔNG làm

- Semantic/vector search, embeddings — như §8, không đổi.
- Thay thế hoàn toàn BM25 bằng usage-ranking — vi phạm ràng buộc chống rich-get-richer (§9.2).
- Làm cho diagnostics "hấp dẫn với user" — sai cửa giá trị (§9.1).

---

## 10. Tiêu chí Done của Wave 3 (v1.3.0)

- [ ] `npm run build` và `npm test` pass sau mỗi WI code (quy tắc verify trong `CLAUDE.md`).
- [ ] `GUIDELINES.md` bump version + assertion trong `src/__tests__/reasoning-audit-tools.test.ts` sync (bắt buộc với WI-3).
- [ ] `README.md`, `CHANGELOG.md` cập nhật cùng change — không để docs trễ một release.
- [ ] `MCP_VERSION` nâng lên `1.3.0` khi release Wave 3.1.
- [ ] Mọi AC trong §4 có test hoặc kịch bản nghiệm thu tương ứng.
- [ ] Git operations do owner thực hiện (theo quy ước làm việc của repo).

## 11. Câu hỏi mở

- **OQ-1:** BM25 có nên đặt trọng số cột `content` cao hơn `tags` không (`bm25(memories_fts, 2.0, 1.0)`)? Đề xuất: để mặc định ở v1.3.0, quyết định sau khi có test relevance chạy trên dữ liệu thật.
- **OQ-2:** Nudge WI-4 có nên mở rộng điều kiện thành "kho < 3 memory" thay vì "kho rỗng"? Đề xuất: giữ "rỗng" — điều kiện chặt nhất, nhiễu bằng 0; nới sau nếu dữ liệu time-to-first-used cho thấy chưa đủ.
- **OQ-3:** Có surface provenance vào phần text summary của `memory_search` không (metadata vốn đã trả trong structured content)? Đề xuất: không làm ở Wave 3 — auto-recall là điểm chạm quan trọng nhất; tránh phình diff.
- **OQ-4 [ĐÃ CHỐT — 2026-07-11, owner]:** ~~Có mở rộng WI-3 để ung-gate thêm event auto-recall/search ở bản mặc định không?~~ **Chốt bằng khung "learning signal ≠ diagnostics" (§9.1):** usage-feedback là learning signal — luôn ghi ở mặc định (đúng phạm vi WI-3 hiện tại); mọi event khác là diagnostics — giữ opt-in. Không mở rộng ung-gate trong Wave 3; chấp nhận §6.2 chỉ đo được khi bật telemetry. Ranh giới này chỉ được mở lại một cách tường minh nếu WI-7 (§9.4) được xét đến ở Wave 4.

---

## 12. Kết luận

Wave 3 không thêm tính năng mới — nó làm cho lời hứa hiện có **giữ được khi người dùng gắn bó lâu**: recall vẫn đúng khi kho lớn lên (WI-1), recall có xuất xứ để tin được (WI-2), **vòng feedback `used` được ghi lại ở bản mặc định** thay vì bị vứt (WI-3 — nhưng các tỷ lệ đo giá trị đầy đủ vẫn cần telemetry, xem §6 và OQ-4), và người dùng mới chạm giá trị trước khi kịp rời đi (WI-4, WI-5). Toàn bộ nằm gọn trong triết lý đã chốt: không dependency mới, không config mới, hành vi đúng là hành vi mặc định.

**Bước tiếp theo đề xuất:** owner review spec → chốt OQ-1..3 (OQ-4 đã chốt ở bản 0.3) → thực thi Wave 3.1 theo trình tự §5, mỗi WI một PR. **Wave 4 (v1.4.0) không nằm trong backlog thực thi** — nó chỉ được kích hoạt bởi evidence gate §9.3, đo sau 4–6 tuần kể từ khi v1.3.0 publish và người dùng đã tích lũy kho memory qua sử dụng thật.

---

## 13. Lịch sử sửa đổi

### 0.3 — 2026-07-11 (bổ sung định hướng v1.4.0 / Wave 4)

- **Chốt OQ-4** bằng khung "learning signal vs diagnostics" (§9.1): usage-feedback luôn ghi ở mặc định (WI-3), mọi event diagnostics giữ opt-in; không mở rộng ung-gate trong Wave 3.
- **Thêm §9 — Định hướng v1.4.0 (Wave 4):** WI-6 (feedback-weighted ranking) vào spec như ứng viên **có điều kiện**, chỉ mở khóa khi evidence gate §9.3 đạt cả 4 điều kiện G-a..G-d sau 4–6 tuần v1.3.0 chạy thật; kèm nhánh fallback WI-6b (sửa guidance để tăng capture rate — rẻ hơn ranker ~100 lần) được kỳ vọng là nhánh xảy ra. WI-7 (dọn kho theo bằng chứng) ghi nhận là ứng viên xa hơn, bị chặn bởi ranh giới diagnostics.
- Ý tưởng WI-6 đã qua một vòng **review phản biện** trước khi vào spec; ba rủi ro tìm thấy (capture phụ thuộc kỷ luật agent — có bằng chứng sống một phiên tuân thủ GUIDELINES vẫn tạo 0 feedback event; kho nhỏ khiến boost không đổi thứ tự; không có bộ eval để kiểm chứng tinh chỉnh) được giữ lại trong §9.2 làm ràng buộc thiết kế và là lý do tồn tại của gate.
- §8: mục "ranking boost theo used-count" chuyển từ "không làm" sang "ứng viên v1.4.0 sau gate → §9".
- Đánh số lại: Tiêu chí Done → §10, Câu hỏi mở → §11, Kết luận → §12, Lịch sử sửa đổi → §13.

### 0.2 — 2026-07-11 (sửa theo review đối chiếu code)

Bản 0.1 được review lại bằng cách đọc code thực tế; các điểm sai/ chưa rõ đã sửa:

- **[Nghiêm trọng] WI-3 thiếu cổng telemetry thứ hai.** Thêm HT-6: `memory_record_usage_feedback` có gate độc lập `telemetryPersistenceEnabled()` (`src/tools/memory.ts:1313`) + mô tả tool hard-code "Requires MEMORY_TELEMETRY=on" (`:1230`). Thiết kế WI-3 nay yêu cầu sửa **cả hai** cổng; FR-3.2 và file list cập nhật theo.
- **[Nghiêm trọng] §6 tự mâu thuẫn với non-goal telemetry.** Viết lại §6 tách "đo được ở bản mặc định" (chỉ raw feedback count) khỏi "cần telemetry on" (các tỷ lệ cần mẫu số recall/search — vốn vẫn bị gate). Thêm OQ-4 cho quyết định có mở rộng ung-gate hay không. FR-3.3 và §11 sửa lại cho trung thực.
- **[Nhỏ] AC-3.1 sai tên trường:** `usage_feedback_recorded` → `used_memory_feedback_recorded` (`src/tools/reasoning.ts:1460`).
- **[Nhỏ] WI-2 sai file:** bỏ `src/types.ts` — `RelatedMemoryRecord` là interface cục bộ tại `src/tools/reasoning.ts:215`.
- **[Rõ ràng] WI-1:** thêm lưu ý `memory_search` phải giữ `tagClause` khi rewrite sang JOIN-rank (`src/tools/memory.ts:349`).
- **[Rõ ràng] AC-1.1:** thêm lưu ý BM25 không bảo đảm "nhiều từ khớp ⇒ rank cao hơn" tuyệt đối — test cần fixture tách biệt có chủ đích.
- **[Rõ ràng] Time-to-first-used:** đánh dấu là hạng mục tương lai (chưa tool nào tính), không phải chỉ số sẵn sàng.
