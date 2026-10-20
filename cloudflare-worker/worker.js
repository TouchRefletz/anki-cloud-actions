/**
 * 🧠 Anki Cloud MCP — Smart Serverless Proxy (Cloudflare Worker)
 *
 * O que este Worker faz:
 * 1. Mantém o endpoint MCP 100% online 24/7 para o Gemini Spark / Claude / Composio.
 * 2. Responde instantaneamente ao checkup inicial (`initialize`, `notifications/initialized`, `tools/list`, `ping`)
 *    mesmo quando o servidor Anki no GitHub Actions está DESLIGADO!
 * 3. Injeta 3 ferramentas nativas no MCP (`anki_cloud_status`, `anki_cloud_start`, `anki_cloud_stop`)
 *    para que a própria IA consiga ligar, esperar ficar pronto e desligar o servidor no MESMO chat.
 * 4. Faz Auto-Wake (Despertar Automático): se a IA chamar qualquer ferramenta do Anki (`list_decks`, `find_notes`, etc.)
 *    enquanto o servidor estiver desligado, o Worker aciona o GitHub Actions automaticamente nos bastidores!
 */

const DEFAULT_CONFIG = {
  NGROK_DOMAIN: "",
  GITHUB_REPO: "TouchRefletz/anki-cloud-actions",
  DEFAULT_DURATION_MINUTES: 30,
};

const CACHED_INIT_RESULT = {"protocolVersion": "2024-11-05", "capabilities": {"experimental": {}, "prompts": {"listChanged": false}, "resources": {"subscribe": false, "listChanged": false}, "tools": {"listChanged": false}}, "serverInfo": {"name": "anki-mcp", "version": "0.40.0", "websiteUrl": "https://ankimcp.ai", "icons": [{"src": "https://ankimcp.ai/favicon.svg", "mimeType": "image/svg+xml", "sizes": ["any"]}]}, "instructions": "CLOUD-MANAGED ANKI SERVER: This Anki MCP server runs on-demand in GitHub Actions and is fronted by an always-on Cloudflare Worker proxy. You have 3 extra cloud management tools available at all times: `anki_cloud_status`, `anki_cloud_start`, and `anki_cloud_stop`. If the cloud server is offline when you call any Anki tool, the proxy will automatically trigger `start-anki` in GitHub Actions and wait up to 25s, or you can call `anki_cloud_start` directly and then `anki_cloud_status(wait_seconds=30)` until it is online. When finished with all user tasks, call `anki_cloud_stop` to sync changes back to AnkiWeb and shut down the cloud runner cleanly. This server works on the user's local Anki collection. When the user syncs Anki across devices, offer to sync with AnkiWeb at the start and end of a session; no tool call syncs implicitly; only the sync tool contacts AnkiWeb. AI-driven review loop: get_due_cards -> present_card (question first, then show_answer=true once the user has answered) -> rate_card, with the user confirming the rating after seeing the answer. Review inside Anki's own window (when the GUI review tools are enabled): gui_deck_review -> gui_current_card -> gui_show_answer -> gui_answer_card; by default the user presses the answer buttons themselves, and gui_answer_card applies only when the user asked for hands-free rating and confirmed the rating; rate_card does not apply to a card shown in Anki's reviewer. Create, edit or delete only the notes, decks, note types and media the user asked for."};

const CACHED_TOOLS = [{"name": "anki_cloud_status", "title": "Anki Cloud Server Status", "description": "Check whether the on-demand Anki Cloud server (GitHub Actions + Ngrok) is currently ONLINE, STARTING (in_progress/queued), or OFFLINE. Optional: pass wait_seconds (1 to 25) to wait/poll until the server comes online before returning (useful right after calling anki_cloud_start).", "inputSchema": {"type": "object", "properties": {"wait_seconds": {"type": "integer", "default": 0, "description": "Seconds to poll/wait for the server to become online (0 = check immediately, max 25)"}}, "title": "anki_cloud_statusArguments"}, "annotations": {"title": "Anki Cloud Server Status", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "anki_cloud_start", "title": "Start Anki Cloud Server", "description": "Wake up / start the Anki Cloud server on GitHub Actions. Downloads the latest collection from AnkiWeb and opens the Ngrok tunnel. Waits up to wait_seconds (default 20s) for the server to come online. If it is still booting after 20s, call anki_cloud_status(wait_seconds=25) until online.", "inputSchema": {"type": "object", "properties": {"duration_minutes": {"type": "integer", "default": 30, "description": "How many minutes the Anki server should stay online before auto-syncing and shutting down (default: 30)"}, "wait_seconds": {"type": "integer", "default": 20, "description": "Seconds to wait for boot before returning status (max 25)"}}, "title": "anki_cloud_startArguments"}, "annotations": {"title": "Start Anki Cloud Server", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "anki_cloud_stop", "title": "Stop Anki Cloud Server (Sync & Shutdown)", "description": "Gracefully sync all Anki changes back to AnkiWeb and shut down the active GitHub Actions runner. Always call this when the user asks to turn off Anki or when an automated maintenance session is complete.", "inputSchema": {"type": "object", "properties": {}, "title": "anki_cloud_stopArguments"}, "annotations": {"title": "Stop Anki Cloud Server", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "add_note", "title": "Add Note", "description": "Add a new note to Anki. Use model_names to see available note types and model_field_names to see required fields. Returns the note ID on success. Intended for notes the user has asked to create.", "inputSchema": {"properties": {"deck_name": {"description": "Deck to add the note to", "title": "Deck Name", "type": "string"}, "model_name": {"description": "Note type to use", "title": "Model Name", "type": "string"}, "fields": {"additionalProperties": {"type": "string"}, "description": "Field values by name, e.g. {\"Front\": \"question\", \"Back\": \"answer\"}", "title": "Fields", "type": "object"}, "tags": {"anyOf": [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}], "default": null, "description": "Tags to apply to the note (JSON array)", "title": "Tags"}, "allow_duplicate": {"default": false, "description": "Skip the duplicate check against the sort field", "title": "Allow Duplicate", "type": "boolean"}}, "required": ["deck_name", "model_name", "fields"], "title": "add_noteArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "add_noteDictOutput", "type": "object"}, "annotations": {"title": "Add Note", "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}}, {"name": "add_notes", "title": "Add Notes", "description": "Add multiple notes to Anki in a single batch sharing the same deck and model. Uses Anki's native batch API for atomic undo support. Supports partial success - individual failures don't affect others. Intended for notes the user has asked to create. Returns summary counts (created, skipped, failed) and a per-note results array with status and note_id. Each note is {\"fields\": {...}, \"tags\": [...]}; tags is a JSON array.", "inputSchema": {"$defs": {"NoteEntry": {"description": "A single note to add in a batch.", "properties": {"fields": {"additionalProperties": {"type": "string"}, "description": "Field values as key-value pairs (e.g., {\"Front\": \"question\", \"Back\": \"answer\"})", "title": "Fields", "type": "object"}, "tags": {"anyOf": [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}], "default": null, "description": "Additional tags for this note (merged with shared tags)", "title": "Tags"}}, "required": ["fields"], "title": "NoteEntry", "type": "object"}}, "properties": {"deck_name": {"description": "Deck to add all notes to", "title": "Deck Name", "type": "string"}, "model_name": {"description": "Note type shared by all notes in this batch", "title": "Model Name", "type": "string"}, "notes": {"description": "Notes to add; each {\"fields\": {...}, \"tags\": [...]}", "items": {"$ref": "#/$defs/NoteEntry"}, "title": "Notes", "type": "array"}, "tags": {"anyOf": [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}], "default": null, "description": "Tags for every note (JSON array)", "title": "Tags"}, "allow_duplicate": {"default": false, "description": "Skip the duplicate check against the sort field", "title": "Allow Duplicate", "type": "boolean"}}, "required": ["deck_name", "model_name", "notes"], "title": "add_notesArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "add_notesDictOutput", "type": "object"}, "annotations": {"title": "Add Notes", "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}}, {"name": "card_reposition", "title": "Reposition New Cards", "description": "Reposition new cards in the new-card queue (set learning order). Only new cards (queue=0) are affected; other cards are silently skipped. Returns repositioned count.", "inputSchema": {"properties": {"card_ids": {"description": "Card IDs to reposition", "items": {"type": "integer"}, "title": "Card Ids", "type": "array"}, "starting_from": {"default": 0, "description": "Starting position (0-based)", "title": "Starting From", "type": "integer"}, "step_size": {"default": 1, "description": "Increment between cards", "title": "Step Size", "type": "integer"}, "randomize": {"default": false, "description": "Shuffle before assigning positions", "title": "Randomize", "type": "boolean"}, "shift_existing": {"default": false, "description": "Push other cards forward", "title": "Shift Existing", "type": "boolean"}}, "required": ["card_ids"], "title": "card_repositionArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "card_repositionDictOutput", "type": "object"}, "annotations": {"title": "Reposition New Cards", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "card_change_deck", "title": "Move Cards to Deck", "description": "Move cards to a different deck, creating the deck if needed. Works with any card type. Cards in a filtered deck are taken out of it. With FSRS on, Anki before 26.09 clears the cards' memory state until their next review; 26.09+ keeps it. Returns moved count and deck_id.", "inputSchema": {"properties": {"card_ids": {"description": "Card IDs to move", "items": {"type": "integer"}, "title": "Card Ids", "type": "array"}, "deck": {"description": "Target deck name (use '::' for nested, e.g., 'Spanish::Verbs')", "title": "Deck", "type": "string"}}, "required": ["card_ids", "deck"], "title": "card_change_deckArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "card_change_deckDictOutput", "type": "object"}, "annotations": {"title": "Move Cards to Deck", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "card_bury", "title": "Bury Cards", "description": "Manually bury cards to hide them until the next day. Works with any card type. Returns buried_count.", "inputSchema": {"properties": {"card_ids": {"description": "Card IDs to bury", "items": {"type": "integer"}, "title": "Card Ids", "type": "array"}}, "required": ["card_ids"], "title": "card_buryArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "card_buryDictOutput", "type": "object"}, "annotations": {"title": "Bury Cards", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "card_unbury", "title": "Unbury Deck Cards", "description": "Restore all buried cards in a deck. Unburies every buried card in the given deck, not specific cards. Returns deck_name.", "inputSchema": {"properties": {"deck_name": {"description": "Deck name to unbury all cards from", "title": "Deck Name", "type": "string"}}, "required": ["deck_name"], "title": "card_unburyArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "card_unburyDictOutput", "type": "object"}, "annotations": {"title": "Unbury Deck Cards", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "card_suspend", "title": "Suspend Cards", "description": "Suspend cards, hiding them from review until they are unsuspended. Works with any card type. Returns suspended_count.", "inputSchema": {"properties": {"card_ids": {"description": "Card IDs to suspend", "items": {"type": "integer"}, "title": "Card Ids", "type": "array"}}, "required": ["card_ids"], "title": "card_suspendArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "card_suspendDictOutput", "type": "object"}, "annotations": {"title": "Suspend Cards", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "card_unsuspend", "title": "Unsuspend Cards", "description": "Unsuspend cards, restoring them to their previous queue. Only cards that are currently suspended are affected. Returns unsuspended_count and card_ids.", "inputSchema": {"properties": {"card_ids": {"description": "Card IDs to unsuspend", "items": {"type": "integer"}, "title": "Card Ids", "type": "array"}}, "required": ["card_ids"], "title": "card_unsuspendArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "card_unsuspendDictOutput", "type": "object"}, "annotations": {"title": "Unsuspend Cards", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "card_set_flag", "title": "Set Card Flag", "description": "Set or remove a colored flag on cards. Flag values: 0=none/remove, 1=red, 2=orange, 3=green, 4=blue, 5-7=custom. Returns flagged_count.", "inputSchema": {"properties": {"card_ids": {"description": "Card IDs to flag", "items": {"type": "integer"}, "title": "Card Ids", "type": "array"}, "flag": {"description": "Flag value: 0=none/remove, 1=red, 2=orange, 3=green, 4=blue, 5-7=custom user flags", "title": "Flag", "type": "integer"}}, "required": ["card_ids", "flag"], "title": "card_set_flagArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "card_set_flagDictOutput", "type": "object"}, "annotations": {"title": "Set Card Flag", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "card_set_due_date", "title": "Set Card Due Date", "description": "Set or change the due date for cards. days: '0' = due now, '5' = due in 5 days, '5-7' = random range, '5!' = also reset interval. Returns affected_count and card_ids.", "inputSchema": {"properties": {"card_ids": {"description": "Card IDs to reschedule", "items": {"type": "integer"}, "title": "Card Ids", "type": "array"}, "days": {"description": "Due date string: '5' = due in 5 days, '5-7' = random range, '0' = due now, '5!' = set due AND reset interval", "title": "Days", "type": "string"}}, "required": ["card_ids", "days"], "title": "card_set_due_dateArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "card_set_due_dateDictOutput", "type": "object"}, "annotations": {"title": "Set Card Due Date", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "card_forget", "title": "Forget Cards", "description": "Reset cards back to the new state, forgetting their scheduling. restore_position (default true) restores the original new-card position; reset_counts (default false) also zeroes review and lapse counts. Returns affected_count and card_ids.", "inputSchema": {"properties": {"card_ids": {"description": "Card IDs to reset to new state", "items": {"type": "integer"}, "title": "Card Ids", "type": "array"}, "restore_position": {"default": true, "description": "Restore original new-card position", "title": "Restore Position", "type": "boolean"}, "reset_counts": {"default": false, "description": "Reset review and lapse counts", "title": "Reset Counts", "type": "boolean"}}, "required": ["card_ids"], "title": "card_forgetArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "card_forgetDictOutput", "type": "object"}, "annotations": {"title": "Forget Cards", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "cards_stats", "title": "Card Statistics", "description": "Bulk per-card scheduling stats for a deck (subdecks included), FSRS-independent. For every matching card returns a compact record: cid, nid, the note's tags, and raw Anki ints for type (0 new, 1 learning, 2 review, 3 relearning) and queue (-3/-2 buried, -1 suspended, 0 new, 1 lrn, 2 rev, 3 day-lrn), plus interval (days) and a computed dueToday flag. No note fields, no HTML, no human-readable names -- just the scheduling metrics, for bulk analytics. Paginated with limit (default 1000, max 1000) and offset; cards are ordered by card id for stable paging. Prefer this over find_notes + notes_info + get_card_memory_state when you only need scheduling metrics: it is one compact read and does not require FSRS.", "inputSchema": {"properties": {"deck": {"description": "Deck name, including subdecks", "title": "Deck", "type": "string"}, "limit": {"default": 1000, "description": "Max cards to return, default 1000, max 1000", "title": "Limit", "type": "integer"}, "offset": {"default": 0, "description": "Cards to skip for pagination", "title": "Offset", "type": "integer"}}, "required": ["deck"], "title": "cards_statsArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "cards_statsDictOutput", "type": "object"}, "annotations": {"title": "Card Statistics", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "create_deck", "title": "Create Deck", "description": "Create a new empty Anki deck. Supports parent::child structure (e.g., \"Japanese::Tokyo\" creates parent deck \"Japanese\" and child deck \"Tokyo\"). Maximum 2 levels of nesting allowed. Will not overwrite existing decks. Creates the deck only; it adds no notes or cards. Returns deckId and created flag (false if deck already existed).", "inputSchema": {"properties": {"deck_name": {"description": "Deck name, optionally \"Parent::Child\" (max 2 levels)", "title": "Deck Name", "type": "string"}}, "required": ["deck_name"], "title": "create_deckArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "create_deckDictOutput", "type": "object"}, "annotations": {"title": "Create Deck", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "create_model", "title": "Create Note Type", "description": "Create a new note type (model) in Anki with custom fields, card templates, and styling. Useful for creating specialized models like RTL (Right-to-Left) language models for Hebrew, Arabic, etc. Each model defines the structure of notes and how cards are generated from them. Returns model_id, fields list, template_count, and any template warnings.\n\nThe result carries \"will_force_full_sync\": collection state read AFTER the write, reporting whether the NEXT sync will be a one-way full sync that overwrites the collection on AnkiWeb and other devices with this one. It does NOT mean this call caused it -- the flag is collection-wide and sticky, so once any earlier operation marked the schema modified it stays true until a full sync clears it. Creating a note type does not itself modify the schema, so this is typically false unless the collection was already dirty.", "inputSchema": {"properties": {"model_name": {"description": "Name for the new note type; must not already exist", "title": "Model Name", "type": "string"}, "in_order_fields": {"description": "Field names in order", "items": {"type": "string"}, "title": "In Order Fields", "type": "array"}, "card_templates": {"description": "Card templates, each a dict with 'Name', 'Front', and 'Back' keys", "items": {"additionalProperties": {"type": "string"}, "type": "object"}, "title": "Card Templates", "type": "array"}, "css": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Stylesheet applied to cards of this model", "title": "Css"}, "is_cloze": {"default": false, "description": "Whether this is a cloze-deletion note type", "title": "Is Cloze", "type": "boolean"}}, "required": ["model_name", "in_order_fields", "card_templates"], "title": "create_modelArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "create_modelDictOutput", "type": "object"}, "annotations": {"title": "Create Note Type", "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}}, {"name": "delete_media_file", "title": "Delete Media File", "description": "Move a media file to Anki's trash folder. The file can be recovered via Anki's 'Check Media' dialog until the trash is emptied. The deletion reaches other devices only after a sync. Intended for files the user has confirmed should be deleted.", "inputSchema": {"properties": {"filename": {"description": "Media filename to move to trash", "title": "Filename", "type": "string"}}, "required": ["filename"], "title": "delete_media_fileArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "delete_media_fileDictOutput", "type": "object"}, "annotations": {"title": "Delete Media File", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "delete_notes", "title": "Delete Notes", "description": "Delete notes by their IDs. This will permanently remove the notes and ALL associated cards. Requires confirmDeletion=true as a safeguard — the call will fail without it. Use dry_run=true to preview what would be deleted without actually deleting anything (confirmDeletion is ignored during dry runs). Returns deletedCount, cardsDeleted, and notFoundCount.", "inputSchema": {"properties": {"notes": {"description": "Note IDs to delete", "items": {"type": "integer"}, "title": "Notes", "type": "array"}, "confirmDeletion": {"description": "Required safeguard; must be true to actually delete", "title": "Confirmdeletion", "type": "boolean"}, "dry_run": {"default": false, "description": "Preview the deletion without removing anything", "title": "Dry Run", "type": "boolean"}}, "required": ["notes", "confirmDeletion"], "title": "delete_notesArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "delete_notesDictOutput", "type": "object"}, "annotations": {"title": "Delete Notes", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "filtered_deck_upsert", "title": "Create or Update Filtered Deck", "description": "Create a new filtered deck (deck_id=0) or update an existing one. Filtered decks temporarily borrow cards from other decks based on 1-2 search terms (Anki's hard limit); cards are moved, not duplicated. Anki may change the name if it conflicts. Returns deck_id, name and card_count.", "inputSchema": {"$defs": {"SearchTermParam": {"properties": {"search": {"description": "Anki search query (e.g., 'deck:Spanish is:due')", "title": "Search", "type": "string"}, "limit": {"default": 100, "description": "Max cards to pull", "minimum": 1, "title": "Limit", "type": "integer"}, "order": {"default": "random", "description": "Card selection order (default matches Anki GUI)", "enum": ["oldest_reviewed_first", "random", "intervals_ascending", "intervals_descending", "lapses", "added", "due", "reverse_added", "retrievability_ascending", "retrievability_descending", "relative_overdueness"], "title": "Order", "type": "string"}}, "required": ["search"], "title": "SearchTermParam", "type": "object"}}, "properties": {"name": {"description": "Deck name (e.g., 'Cram Session' or 'Study::Filtered')", "title": "Name", "type": "string"}, "search_terms": {"description": "1-2 search terms defining which cards to pull", "items": {"$ref": "#/$defs/SearchTermParam"}, "maxItems": 2, "minItems": 1, "title": "Search Terms", "type": "array"}, "deck_id": {"default": 0, "description": "0 = create new deck, non-zero = update existing filtered deck", "title": "Deck Id", "type": "integer"}, "reschedule": {"default": true, "description": "Update scheduling after review (recommended True)", "title": "Reschedule", "type": "boolean"}, "allow_empty": {"default": true, "description": "Allow creation even if search matches 0 cards. When False, the ENTIRE operation is rolled back if no cards match -- deck is NOT created.", "title": "Allow Empty", "type": "boolean"}}, "required": ["name", "search_terms"], "title": "filtered_deck_upsertArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "filtered_deck_upsertDictOutput", "type": "object"}, "annotations": {"title": "Create or Update Filtered Deck", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "filtered_deck_rebuild", "title": "Rebuild Filtered Deck", "description": "Rebuild a filtered deck: return all its cards to their home decks, then re-pull cards matching its search terms. Returns card_count after the rebuild.", "inputSchema": {"properties": {"deck_id": {"description": "Filtered deck ID", "title": "Deck Id", "type": "integer"}}, "required": ["deck_id"], "title": "filtered_deck_rebuildArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "filtered_deck_rebuildDictOutput", "type": "object"}, "annotations": {"title": "Rebuild Filtered Deck", "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}}, {"name": "filtered_deck_empty", "title": "Empty Filtered Deck", "description": "Empty a filtered deck, returning all its cards to their original decks. Card scheduling is preserved. Returns deck_id.", "inputSchema": {"properties": {"deck_id": {"description": "Filtered deck ID", "title": "Deck Id", "type": "integer"}}, "required": ["deck_id"], "title": "filtered_deck_emptyArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "filtered_deck_emptyDictOutput", "type": "object"}, "annotations": {"title": "Empty Filtered Deck", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "filtered_deck_delete", "title": "Delete Filtered Deck", "description": "Delete a filtered deck after returning all its cards to their original decks. Cards are not deleted; they keep their scheduling. Returns deck_id.", "inputSchema": {"properties": {"deck_id": {"description": "Filtered deck ID", "title": "Deck Id", "type": "integer"}}, "required": ["deck_id"], "title": "filtered_deck_deleteArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "filtered_deck_deleteDictOutput", "type": "object"}, "annotations": {"title": "Delete Filtered Deck", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "filtered_deck_get_info", "title": "Get Filtered Deck Info", "description": "Inspect the configuration of up to 50 decks by ID. Non-filtered decks are included with is_filtered=false; unknown deck IDs are skipped and counted in not_found. Returns search terms, limit, order, reschedule setting and card count per deck.", "inputSchema": {"properties": {"deck_ids": {"description": "Deck IDs to inspect (max 50)", "items": {"type": "integer"}, "maxItems": 50, "minItems": 1, "title": "Deck Ids", "type": "array"}}, "required": ["deck_ids"], "title": "filtered_deck_get_infoArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "filtered_deck_get_infoDictOutput", "type": "object"}, "annotations": {"title": "Get Filtered Deck Info", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "find_notes", "title": "Find Notes", "description": "Search for notes using Anki query syntax. Returns an array of note IDs matching the query. Supports pagination with limit/offset parameters. Maximum limit is 500 per request. Examples: \"deck:Spanish\", \"tag:verb\", \"is:due\", \"front:hello\", \"added:1\" (cards added today), \"prop:due<=2\" (cards due within 2 days), \"flag:1\" (red flag), \"is:suspended\". Set include_first_field=true to also get a 'noteLabels' array of {noteId, firstField} entries (first field excerpted at 250 chars, with truncated/fullLength markers) - one call to find AND label results instead of find_notes followed by notes_info. The labels identify notes; read full content with notes_info before editing. Pass 'noteIds' (not 'noteLabels') to any tool that wants note IDs.", "inputSchema": {"properties": {"query": {"description": "Anki search query, e.g. \"deck:Spanish\" or \"is:due\"", "title": "Query", "type": "string"}, "limit": {"default": 100, "description": "Maximum note IDs to return (max 500)", "title": "Limit", "type": "integer"}, "offset": {"default": 0, "description": "Results to skip, for pagination", "title": "Offset", "type": "integer"}, "include_first_field": {"default": false, "description": "Also return each note's excerpted first field", "title": "Include First Field", "type": "boolean"}}, "required": ["query"], "title": "find_notesArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "find_notesDictOutput", "type": "object"}, "annotations": {"title": "Find Notes", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "get_card_memory_state", "title": "Card Memory State", "description": "Get FSRS memory state (stability, difficulty, retrievability) for one or more cards. Requires FSRS to be enabled. Returns per-card memory state along with scheduling info. Use recompute=True to recalculate from the review log (slower but ensures accuracy).", "inputSchema": {"properties": {"card_ids": {"description": "Card IDs to look up", "items": {"type": "integer"}, "title": "Card Ids", "type": "array"}, "recompute": {"default": false, "description": "Recalculate from the review log instead of using the cached state", "title": "Recompute", "type": "boolean"}}, "required": ["card_ids"], "title": "get_card_memory_stateArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "get_card_memory_stateDictOutput", "type": "object"}, "annotations": {"title": "Card Memory State", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "get_due_cards", "title": "Next Due Card", "description": "Retrieve the next single card due for review from a specified deck in true scheduler order. Reads the local collection as-is and does not sync with AnkiWeb, so reviews made on other devices since the last sync are not reflected. Returns one card per call to ensure correct scheduler interleaving. The deck_name parameter is required - you must specify which deck to study. For voice-mode review, use skip_images=True and/or skip_audio=True to filter out cards with media. Cards with media are temporarily buried (removed from queue) and can be unburied later using the card_unbury tool. Response includes has_images and has_audio flags for each card. deckName is the card's home deck; filteredDeckName is always present and is null unless the card is currently being studied from a filtered deck. The answer is omitted by default (no 'back' key) so a review session does not receive it before the user responds. Pass include_answer=True to also receive 'back' - for content analysis or editing, not for reviewing. front (and back, when requested) are rendered card HTML like present_card's question/answer, not raw note fields; front omits the note type CSS.", "inputSchema": {"properties": {"deck_name": {"description": "Deck to pull the next due card from", "title": "Deck Name", "type": "string"}, "skip_images": {"default": false, "description": "Bury and skip cards containing images", "title": "Skip Images", "type": "boolean"}, "skip_audio": {"default": false, "description": "Bury and skip cards containing audio", "title": "Skip Audio", "type": "boolean"}, "include_answer": {"default": false, "description": "Also return the rendered answer ('back'), not just the question", "title": "Include Answer", "type": "boolean"}}, "required": ["deck_name"], "title": "get_due_cardsArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "get_due_cardsDictOutput", "type": "object"}, "annotations": {"title": "Next Due Card", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "get_fsrs_params", "title": "Get FSRS Parameters", "description": "Get FSRS scheduler parameters for Anki deck presets. Returns FSRS weights, desired retention, max interval, and other settings. If deck_name is empty, returns parameters for all presets with their associated decks. If deck_name is provided, returns parameters for the preset used by that deck.", "inputSchema": {"properties": {"deck_name": {"default": "", "description": "Deck to look up the preset for; empty returns all presets", "title": "Deck Name", "type": "string"}}, "title": "get_fsrs_paramsArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "get_fsrs_paramsDictOutput", "type": "object"}, "annotations": {"title": "Get FSRS Parameters", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "get_media_files_names", "title": "List Media Files", "description": "List all media files in Anki's media folder with optional pattern filtering. Use patterns like '*.mp3' for audio files, '*.jpg' for images, etc.", "inputSchema": {"properties": {"pattern": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Glob pattern to filter filenames, e.g. '*.mp3'", "title": "Pattern"}}, "title": "get_media_files_namesArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "get_media_files_namesDictOutput", "type": "object"}, "annotations": {"title": "List Media Files", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "list_decks", "title": "List Decks", "description": "List all available Anki decks, optionally with statistics. Counts reflect the local collection at call time; this call does not sync with AnkiWeb. Returns deck objects with deck_id, name, and is_filtered. With include_stats=true, adds per-deck card counts (new, learn, review, total).", "inputSchema": {"properties": {"include_stats": {"default": false, "description": "Add per-deck card counts (new, learn, review, total)", "title": "Include Stats", "type": "boolean"}}, "title": "list_decksArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "list_decksDictOutput", "type": "object"}, "annotations": {"title": "List Decks", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "model_field_names", "title": "Note Type Field Names", "description": "Get the field names and descriptions for a specific note type (model). Use this to know what fields are required when creating notes of this type. Returns both field_names (list of strings) and fields (list of objects with name and description).", "inputSchema": {"properties": {"model_name": {"description": "Note type to inspect", "title": "Model Name", "type": "string"}}, "required": ["model_name"], "title": "model_field_namesArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "model_field_namesDictOutput", "type": "object"}, "annotations": {"title": "Note Type Field Names", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "model_field_add", "title": "Add Note Type Field", "description": "Add a new field to a note type, optionally at a 0-based index (default: appended at the end). This changes the note type schema, which forces a one-way full sync on the next sync -- it overwrites the collection on AnkiWeb and your other devices. The result carries \"will_force_full_sync\": collection state read AFTER the write, reporting whether the NEXT sync will be a one-way full sync that overwrites the collection on AnkiWeb and other devices with this one. It does NOT mean this call caused it -- the flag is collection-wide and sticky, so once any earlier operation marked the schema modified it stays true until a full sync clears it. This tool therefore always reports true.", "inputSchema": {"properties": {"model_name": {"description": "Name of the note type (model) to modify", "title": "Model Name", "type": "string"}, "field_name": {"description": "Name of the new field to add", "title": "Field Name", "type": "string"}, "index": {"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null, "description": "0-based position for the new field (0..field_count, inclusive). Omit to append at the end.", "title": "Index"}}, "required": ["model_name", "field_name"], "title": "model_field_addArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "model_field_addDictOutput", "type": "object"}, "annotations": {"title": "Add Note Type Field", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "model_field_rename", "title": "Rename Note Type Field", "description": "Rename a field of a note type, keeping its content. Anki rewrites references to the field in the card templates to the new name. Renaming does not itself modify the schema. The result carries \"will_force_full_sync\": collection state read AFTER the write, reporting whether the NEXT sync will be a one-way full sync that overwrites the collection on AnkiWeb and other devices with this one. It does NOT mean this call caused it -- the flag is collection-wide and sticky, so once any earlier operation marked the schema modified it stays true until a full sync clears it. This tool reports true only if the collection was already dirty.", "inputSchema": {"properties": {"model_name": {"description": "Name of the note type (model) to modify", "title": "Model Name", "type": "string"}, "field_name": {"description": "Current name of the field to rename", "title": "Field Name", "type": "string"}, "new_name": {"description": "New name for the field", "title": "New Name", "type": "string"}}, "required": ["model_name", "field_name", "new_name"], "title": "model_field_renameArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "model_field_renameDictOutput", "type": "object"}, "annotations": {"title": "Rename Note Type Field", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "model_field_reposition", "title": "Reposition Note Type Field", "description": "Move an existing field of a note type to a new 0-based position. This changes the note type schema, which forces a one-way full sync on the next sync -- it overwrites the collection on AnkiWeb and your other devices. The result carries \"will_force_full_sync\": collection state read AFTER the write, reporting whether the NEXT sync will be a one-way full sync that overwrites the collection on AnkiWeb and other devices with this one. It does NOT mean this call caused it -- the flag is collection-wide and sticky, so once any earlier operation marked the schema modified it stays true until a full sync clears it. This tool therefore always reports true.", "inputSchema": {"properties": {"model_name": {"description": "Name of the note type (model) to modify", "title": "Model Name", "type": "string"}, "field_name": {"description": "Name of the field to move", "title": "Field Name", "type": "string"}, "index": {"description": "0-based target position for the field (0..field_count-1)", "title": "Index", "type": "integer"}}, "required": ["model_name", "field_name", "index"], "title": "model_field_repositionArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "model_field_repositionDictOutput", "type": "object"}, "annotations": {"title": "Reposition Note Type Field", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "model_names", "title": "Note Type Names", "description": "Get a list of all available note type (model) names in Anki. Use this to see what note types are available before creating notes. Returns modelNames list and commonTypes shortcuts (basic, basicReversed, cloze).", "inputSchema": {"properties": {}, "title": "model_namesArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "model_namesDictOutput", "type": "object"}, "annotations": {"title": "Note Type Names", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "model_styling", "title": "Note Type Styling", "description": "Get the CSS styling for a specific note type (model). This CSS is used when rendering cards of this type. Set include_latex=true to additionally return the model's LaTeX preamble ('latex_pre', 'latex_post', 'latex_svg') -- the header/footer wrapped around [latex] and [$]...[/$] blocks when rendering them. Only ask for it when diagnosing or fixing LaTeX/TikZ rendering; it is omitted by default.", "inputSchema": {"properties": {"model_name": {"description": "Note type to inspect", "title": "Model Name", "type": "string"}, "include_latex": {"default": false, "description": "Also return latex_pre/latex_post/latex_svg", "title": "Include Latex", "type": "boolean"}}, "required": ["model_name"], "title": "model_stylingArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "model_stylingDictOutput", "type": "object"}, "annotations": {"title": "Note Type Styling", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "model_templates", "title": "Note Type Templates", "description": "Get the card template HTML (Front and Back) for each card type in a note type (model). Returns the raw HTML templates used to render cards during review and editing.", "inputSchema": {"properties": {"model_name": {"description": "Note type to inspect", "title": "Model Name", "type": "string"}}, "required": ["model_name"], "title": "model_templatesArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "model_templatesDictOutput", "type": "object"}, "annotations": {"title": "Note Type Templates", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "notes_info", "title": "Note Details", "description": "Get detailed information about specific notes including all fields, tags, model info, and CSS styling. Use this after find_notes to get complete note data. Includes CSS for proper rendering awareness. Use include_fields to return only specific fields, or exclude_fields to omit fields - useful for reducing response size in bulk queries. If both are provided, include_fields takes priority. Use excerpt_chars (>= 1) to cap every returned field value at that many characters; each field then also carries truncated (bool) and fullLength (original character count). Excerpts exist to IDENTIFY notes cheaply, NOT to search their content - content search belongs in find_notes queries, which run server-side over full content. A truncated value is not a safe basis for an edit: writing it back stores the cut-off value. The full value comes from a call without excerpt_chars.", "inputSchema": {"properties": {"notes": {"description": "Note IDs to fetch", "items": {"type": "integer"}, "title": "Notes", "type": "array"}, "include_fields": {"anyOf": [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}], "default": null, "description": "Return only these fields (takes priority over exclude_fields)", "title": "Include Fields"}, "exclude_fields": {"anyOf": [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}], "default": null, "description": "Omit these fields from the response", "title": "Exclude Fields"}, "excerpt_chars": {"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null, "description": "Truncate each field value to this many characters", "title": "Excerpt Chars"}}, "required": ["notes"], "title": "notes_infoArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "notes_infoDictOutput", "type": "object"}, "annotations": {"title": "Note Details", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "optimize_fsrs_params", "title": "Optimize FSRS Parameters", "description": "Run FSRS parameter optimization for a deck config preset using Anki's built-in optimizer. This analyzes review history to find optimal FSRS weights. Set apply_results=False (default) for a dry run that shows what the optimized params would be. Set apply_results=True to save the optimized parameters. This operation runs synchronously and typically takes 5-30 seconds depending on review history size. Returns current_params vs optimized_params comparison, already_optimal flag, and applied flag.", "inputSchema": {"properties": {"preset_name": {"description": "Deck config preset to optimize", "title": "Preset Name", "type": "string"}, "apply_results": {"default": false, "description": "Save the optimized params instead of a dry run", "title": "Apply Results", "type": "boolean"}}, "required": ["preset_name"], "title": "optimize_fsrs_paramsArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "optimize_fsrs_paramsDictOutput", "type": "object"}, "annotations": {"title": "Optimize FSRS Parameters", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "present_card", "title": "Present Card", "description": "Retrieve a card's content for review. Returns the question only unless show_answer=true, so the answer can be withheld until the user has responded. This call does not rate the card; rating is a separate rate_card call. Returns a card object with card_id, question (rendered HTML, always returned), answer (rendered HTML, only when show_answer=true), deck_name, filtered_deck_name, note_type, and scheduling fields (interval, ease_factor, due, reviews, lapses). deck_name is the card's home deck; filtered_deck_name is always present and is null unless the card is currently being studied from a filtered deck.", "inputSchema": {"properties": {"card_id": {"description": "Card to present", "title": "Card Id", "type": "integer"}, "show_answer": {"default": false, "description": "Include the rendered answer", "title": "Show Answer", "type": "boolean"}}, "required": ["card_id"], "title": "present_cardArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "present_cardDictOutput", "type": "object"}, "annotations": {"title": "Present Card", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "rate_card", "title": "Rate Card", "description": "Submit a rating for a card to update Anki's spaced repetition scheduling. Precondition: the answer must already have been revealed to the user via present_card(show_answer=true), and the user must have confirmed or modified your suggested rating. The rating is applied to the schedule immediately, so it is meant for a rating the user has confirmed after seeing the answer. Returns next_review date, new_interval (days for review cards), and card_type.", "inputSchema": {"properties": {"card_id": {"description": "Card to rate", "title": "Card Id", "type": "integer"}, "rating": {"description": "Rating 1-4 (1=Again, 2=Hard, 3=Good, 4=Easy)", "title": "Rating", "type": "integer"}}, "required": ["card_id", "rating"], "title": "rate_cardArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "rate_cardDictOutput", "type": "object"}, "annotations": {"title": "Rate Card", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "set_fsrs_params", "title": "Set FSRS Parameters", "description": "Update FSRS parameters on a deck config preset. Can set FSRS weights, desired retention (0.70-0.99), and/or max interval. At least one parameter must be changed. Returns old/new diff for each changed field. Use get_fsrs_params first to see current values.", "inputSchema": {"properties": {"preset_name": {"description": "Deck config preset to update", "title": "Preset Name", "type": "string"}, "fsrs_params": {"anyOf": [{"items": {"type": "number"}, "type": "array"}, {"type": "null"}], "default": null, "description": "FSRS weights array, must match the count expected by the enabled FSRS version", "title": "Fsrs Params"}, "desired_retention": {"default": -1.0, "description": "Desired retention, 0.70-0.99; omit by leaving at -1.0", "title": "Desired Retention", "type": "number"}, "max_interval": {"default": -1, "description": "Max interval in days; omit by leaving at -1", "title": "Max Interval", "type": "integer"}}, "required": ["preset_name"], "title": "set_fsrs_paramsArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "set_fsrs_paramsDictOutput", "type": "object"}, "annotations": {"title": "Set FSRS Parameters", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "store_media_file", "title": "Store Media File", "description": "Store a media file to Anki's collection.media folder. Accepts files via base64 data, local file path, or URL. Use this to add images, audio, or other media files that can be referenced in note fields. Returns the stored filename and full path. See https://docs.ankiweb.net/media.html for how Anki stores and references media. URL fetches to private-network addresses are blocked unless the host is listed in the media_allowed_hosts config.", "inputSchema": {"properties": {"filename": {"description": "Filename to store the media under", "title": "Filename", "type": "string"}, "data": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Base64-encoded file content; mutually exclusive with path/url", "title": "Data"}, "path": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Local file path to read from; mutually exclusive with data/url", "title": "Path"}, "url": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "URL to download the file from; mutually exclusive with data/path", "title": "Url"}}, "required": ["filename"], "title": "store_media_fileArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "store_media_fileDictOutput", "type": "object"}, "annotations": {"title": "Store Media File", "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true}}, {"name": "sync", "title": "Sync with AnkiWeb", "description": "Synchronize the local Anki collection with AnkiWeb. This is an ASYNCHRONOUS job: one tool, three call shapes, driven by which arguments you pass.\n\nTHE THREE CALL SHAPES:\n  1. sync()                     -> start a sync\n  2. sync(job_id=\"...\")         -> check that sync's progress/result\n  3. sync(job_id=\"...\", resolve=\"upload\"|\"download\"|\"cancel\") -> resolve a conflict\n\nSTEP 1 -- START. Call sync with NO arguments. You get back {job_id, status:'running'}. The sync is NOT finished yet -- 'running' only means it has begun. Keep the job_id.\n\nSTEP 2 -- POLL until done. Call sync AGAIN passing ONLY that job_id (sync(job_id=\"...\")). This returns the job's status snapshot. One poll is usually not enough -- the sync is finished only once status becomes one of the FOUR terminal values: 'success', 'error', 'conflict', or 'cancelled'. While status is still 'running', wait briefly and poll again.\n\nSTEP 3 -- HANDLE the terminal status:\n  * 'success'   -> done, the collection is in sync. Nothing more to do.\n  * 'conflict'  -> a one-way full sync is required. Look at the snapshot's legal_directions and call sync with the job_id AND resolve set to one of them: resolve='upload' pushes LOCAL -> AnkiWeb (your computer wins), resolve='download' pulls AnkiWeb -> LOCAL (the server wins). WARNING: the wrong direction PERMANENTLY DISCARDS the data on the losing side. Only pass a direction that appears in legal_directions. If you are unsure which side is correct, call sync with the job_id and resolve='cancel' to abandon safely -- nothing is transferred, the collection is left untouched, and a fresh sync() can be started later. After resolve='upload'/'download' you get a new {status:'running'} -- go back to STEP 2 and poll again.\n  * 'error'     -> inspect error.code. error.code=='auth_failed' means the AnkiWeb login expired or failed and the USER must re-authenticate (in Anki: Tools > Preferences, or the Sync button) before a new sync will work. error.hint (when present) is a human-readable next step.\n  * 'cancelled' -> a conflict was abandoned; nothing was transferred.\n\nGUARDRAILS: resolve REQUIRES a job_id (calling sync with resolve but no job_id is an error -- resolve needs a job to act on). An unknown or expired job_id returns a not_found error.\n\nSNAPSHOT FIELDS returned by sync(job_id): status (running|conflict|success|error|cancelled), phase (checking|full_transfer|media|done), legal_directions (the resolve options, only when status=='conflict'), required (only when status=='conflict': the ChangesRequired name that forced the full sync; null otherwise), result (on success), error ({code, message, category, hint} on error), job_id, started_at, finished_at.\n\nRESULT FIELDS (on status=='success'): result.outcome is the backend's post-sync state -- 'NO_CHANGES' (nothing to transfer) or 'NORMAL_SYNC' (changes were transferred); either way the sync is COMPLETE and nothing further is required. It is distinct from the top-level 'required' field, which is only populated for conflicts (null otherwise). On the resolve path result carries resolved:true instead of outcome. result.media_error is null when media synced fine, or an error payload when media failed -- media is best-effort and never fails the collection sync itself.\n\nSCOPE: this is the only tool that talks to AnkiWeb. No other tool syncs on its own; the other tools read and write the local collection without contacting AnkiWeb. Running it at the start and end of a session keeps other devices' reviews and local changes in step.", "inputSchema": {"properties": {"job_id": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Job to poll or resolve; omit to start a new sync", "title": "Job Id"}, "resolve": {"anyOf": [{"enum": ["upload", "download", "cancel"], "type": "string"}, {"type": "null"}], "default": null, "description": "Direction to resolve a full-sync conflict; requires job_id", "title": "Resolve"}}, "title": "syncArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "syncDictOutput", "type": "object"}, "annotations": {"title": "Sync with AnkiWeb", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": true}}, {"name": "tag_add", "title": "Add Tags", "description": "Add tags to notes by note ID. tags is a space-separated list of tag names (e.g. 'vocab grammar'). Returns added_count.", "inputSchema": {"properties": {"note_ids": {"description": "Note IDs to add tags to", "items": {"type": "integer"}, "title": "Note Ids", "type": "array"}, "tags": {"description": "Space-separated tag names to add (e.g., 'vocab grammar')", "title": "Tags", "type": "string"}}, "required": ["note_ids", "tags"], "title": "tag_addArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "tag_addDictOutput", "type": "object"}, "annotations": {"title": "Add Tags", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "tag_remove", "title": "Remove Tags", "description": "Remove tags from notes by note ID. tags is a space-separated list of tag names; removal is case-insensitive and also removes child tags (tag::...). Returns removed_count.", "inputSchema": {"properties": {"note_ids": {"description": "Note IDs to remove tags from", "items": {"type": "integer"}, "title": "Note Ids", "type": "array"}, "tags": {"description": "Space-separated tag names to remove (e.g., 'vocab grammar')", "title": "Tags", "type": "string"}}, "required": ["note_ids", "tags"], "title": "tag_removeArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "tag_removeDictOutput", "type": "object"}, "annotations": {"title": "Remove Tags", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "tag_replace", "title": "Replace Tag", "description": "Replace a tag with another on specific notes. Adds new_tag then removes old_tag on the given notes. The removal matches case-insensitively and also strips old_tag's child tags (old_tag::...), so a new_tag equal to old_tag ignoring case, or a child of it, is rejected before anything is written. Returns added_count and removed_count.", "inputSchema": {"properties": {"note_ids": {"description": "Note IDs to replace tags on", "items": {"type": "integer"}, "title": "Note Ids", "type": "array"}, "old_tag": {"description": "Tag to remove", "title": "Old Tag", "type": "string"}, "new_tag": {"description": "Tag to add in place of old_tag", "title": "New Tag", "type": "string"}}, "required": ["note_ids", "old_tag", "new_tag"], "title": "tag_replaceArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "tag_replaceDictOutput", "type": "object"}, "annotations": {"title": "Replace Tag", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "tag_list", "title": "List Tags", "description": "List all tags in the collection. The optional deck param scopes results to tags on notes with at least one card in that deck (subdecks included); omit it for all collection tags. Returns tags array and count.", "inputSchema": {"properties": {"deck": {"default": "", "description": "Optional deck name to scope tags to notes with a card in this deck (subdecks included). Omit or leave empty for all collection tags.", "title": "Deck", "type": "string"}}, "title": "tag_listArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "tag_listDictOutput", "type": "object"}, "annotations": {"title": "List Tags", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "tag_clear_unused", "title": "Clear Unused Tags", "description": "Remove tags that are not used by any note. Takes no parameters. Returns cleared_count.", "inputSchema": {"properties": {}, "title": "tag_clear_unusedArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "tag_clear_unusedDictOutput", "type": "object"}, "annotations": {"title": "Clear Unused Tags", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "tag_batch", "title": "Batch Tag Operations", "description": "Apply multiple add/remove tag operations in a single call. Each operation specifies type ('add' or 'remove'), note_ids, and tags. Operations execute in order with partial success support. Max 50 operations. Returns per-operation results with affected_count, plus succeeded/failed totals.", "inputSchema": {"$defs": {"TagOperation": {"description": "A single tag operation within a batch.", "properties": {"type": {"description": "Operation type: 'add' to add tags, 'remove' to remove tags", "enum": ["add", "remove"], "title": "Type", "type": "string"}, "note_ids": {"description": "Note IDs to apply this operation to", "items": {"type": "integer"}, "title": "Note Ids", "type": "array"}, "tags": {"description": "Space-separated tag names (e.g., 'vocab grammar')", "title": "Tags", "type": "string"}}, "required": ["type", "note_ids", "tags"], "title": "TagOperation", "type": "object"}}, "properties": {"operations": {"description": "List of tag operations. Each has: type ('add'/'remove'), note_ids (list of ints), tags (space-separated string). Executed in order.", "items": {"$ref": "#/$defs/TagOperation"}, "title": "Operations", "type": "array"}}, "required": ["operations"], "title": "tag_batchArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "tag_batchDictOutput", "type": "object"}, "annotations": {"title": "Batch Tag Operations", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "update_model_styling", "title": "Update Note Type Styling", "description": "Update the CSS styling (and optionally the LaTeX preamble) of an existing note type (model). Changes apply to all cards using this model.\n\nTWO MUTUALLY EXCLUSIVE CSS INPUT MODES -- use exactly one, or neither when only writing LaTeX fields:\n  1. FULL REPLACE: pass 'css' with the complete new stylesheet.\n  2. PATCH: pass 'old_str' + 'new_str' to replace a snippet in place, like a text editor's find-and-replace. 'old_str' must match the current CSS EXACTLY ONCE (whitespace is significant); 0 matches or 2+ matches is an error and nothing is written. On a 0-match error the response includes an excerpt of the current CSS so you can correct 'old_str' and retry without a separate read. Prefer PATCH for small edits -- it avoids resending the whole stylesheet and cannot silently clobber concurrent changes.\n  TRANSPORT CAVEAT: if 'old_str' or 'new_str' would consist ENTIRELY of a JSON value -- exactly `null`, or a complete JSON array/object such as `[\"x\"]` or `{\"a\": 1}` -- it can be mis-read in transit and the call rejected. Include an adjacent character of surrounding context in the string to avoid it.\n\nOPTIONAL LATEX PREAMBLE: 'latex_pre', 'latex_post' and 'latex_svg' set the LaTeX header/footer/SVG-rendering flag used when rendering [latex] and [$]...[/$] blocks. Only the ones you pass are written, and they combine with either CSS mode or can be sent alone. Use them to fix [latex]/TikZ rendering (e.g. adding \\usepackage{tikz} to 'latex_pre'). Most models never need these -- leave them out unless LaTeX is actually broken. Read the current values with model_styling(include_latex=true).\n\nThe result carries \"will_force_full_sync\": collection state read AFTER the write, reporting whether the NEXT sync will be a one-way full sync that overwrites the collection on AnkiWeb and other devices with this one. It does NOT mean this call caused it -- the flag is collection-wide and sticky, so once any earlier operation marked the schema modified it stays true until a full sync clears it. Editing CSS or the LaTeX preamble does not itself modify the schema, so this is typically false unless the collection was already dirty.", "inputSchema": {"properties": {"model_name": {"description": "Note type to update", "title": "Model Name", "type": "string"}, "css": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "New full CSS content (full-content mode; mutually exclusive with old_str/new_str)", "title": "Css"}, "old_str": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Exact existing CSS text to replace (patch mode; must match exactly once)", "title": "Old Str"}, "new_str": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Replacement CSS text (patch mode; paired with old_str)", "title": "New Str"}, "latex_pre": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "New LaTeX preamble header (independent of CSS mode)", "title": "Latex Pre"}, "latex_post": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "New LaTeX preamble footer (independent of CSS mode)", "title": "Latex Post"}, "latex_svg": {"anyOf": [{"type": "boolean"}, {"type": "null"}], "default": null, "description": "Whether to render LaTeX as SVG (independent of CSS mode)", "title": "Latex Svg"}}, "required": ["model_name"], "title": "update_model_stylingArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "update_model_stylingDictOutput", "type": "object"}, "annotations": {"title": "Update Note Type Styling", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "update_model_templates", "title": "Update Note Type Templates", "description": "Update the card template HTML (Front/Back) of a note type (model). Changes apply to all future renders; existing cards keep their generated content but will use the new template on next render.\n\nTWO MUTUALLY EXCLUSIVE INPUT MODES -- use exactly one:\n  1. FULL REPLACE: pass 'templates' as {card template name: {'Front': html, 'Back': html}}. Front/Back are optional per template but replace the whole side. Multiple templates can be updated in one call.\n  2. PATCH: pass 'template_name' + 'side' ('Front' or 'Back') + 'old_str' + 'new_str' to replace a snippet in place, like a text editor's find-and-replace. 'old_str' must match that side's current HTML EXACTLY ONCE (whitespace is significant); 0 matches or 2+ matches is an error and nothing is written. On a 0-match error the response includes an excerpt of the current HTML so you can correct 'old_str' and retry without a separate read. Patch mode touches exactly one side of one template. Prefer PATCH for small edits -- it avoids resending the whole template and cannot silently clobber concurrent changes.\n  TRANSPORT CAVEAT: if 'old_str' or 'new_str' would consist ENTIRELY of a JSON value -- exactly `null`, or a complete JSON array/object such as `[\"x\"]` or `{\"a\": 1}` -- it can be mis-read in transit and the call rejected. Include an adjacent character of surrounding context in the string to avoid it.\n\nUse model_templates to read current template names and HTML.\n\nThe result carries \"will_force_full_sync\": collection state read AFTER the write, reporting whether the NEXT sync will be a one-way full sync that overwrites the collection on AnkiWeb and other devices with this one. It does NOT mean this call caused it -- the flag is collection-wide and sticky, so once any earlier operation marked the schema modified it stays true until a full sync clears it. Editing the HTML of existing card templates does not itself modify the schema, so this is typically false unless the collection was already dirty.", "inputSchema": {"properties": {"model_name": {"description": "Note type to update", "title": "Model Name", "type": "string"}, "templates": {"anyOf": [{"additionalProperties": {"additionalProperties": {"type": "string"}, "type": "object"}, "type": "object"}, {"type": "null"}], "default": null, "description": "New Front/Back HTML by card template name (full-content mode; mutually exclusive with template_name/side/old_str/new_str)", "title": "Templates"}, "template_name": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Card template to patch (patch mode)", "title": "Template Name"}, "side": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Which side to patch, 'Front' or 'Back' (patch mode)", "title": "Side"}, "old_str": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Exact existing HTML text to replace (patch mode; must match exactly once)", "title": "Old Str"}, "new_str": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Replacement HTML text (patch mode; paired with old_str)", "title": "New Str"}}, "required": ["model_name"], "title": "update_model_templatesArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "update_model_templatesDictOutput", "type": "object"}, "annotations": {"title": "Update Note Type Templates", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "update_note_fields", "title": "Update Note Fields", "description": "Update the fields of an existing note. Supports HTML content in fields and preserves CSS styling.\n\nTWO MUTUALLY EXCLUSIVE INPUT MODES -- use exactly one:\n  1. FULL REPLACE: pass 'fields' as {field name: new full value}. Each listed field is overwritten entirely; fields you omit are left alone.\n  2. PATCH: pass 'field_name' + 'old_str' + 'new_str' to replace a snippet in place, like a text editor's find-and-replace. 'old_str' must match that field's current value EXACTLY ONCE (whitespace and HTML markup are significant); 0 matches or 2+ matches is an error and nothing is written. On a 0-match error the response includes an excerpt of the current value so you can correct 'old_str' and retry without a separate read. Patch mode touches exactly one field. Prefer PATCH for small edits to long fields -- it avoids resending the whole value and cannot silently clobber concurrent changes.\n  TRANSPORT CAVEAT: if 'old_str' or 'new_str' would consist ENTIRELY of a JSON value -- exactly `null`, or a complete JSON array/object such as `[\"x\"]` or `{\"a\": 1}` -- it can be mis-read in transit and the call rejected. Include an adjacent character of surrounding context in the string to avoid it.\n\nNote: media file attachment (audio/picture) is not yet supported. WARNING: if the note is open in the Anki browser while it is updated, the fields will not update properly; closing the browser or switching it to a different note first avoids this. Intended for notes the user has asked to modify.", "inputSchema": {"properties": {"id": {"description": "Note ID to update", "title": "Id", "type": "integer"}, "fields": {"anyOf": [{"additionalProperties": {"type": "string"}, "type": "object"}, {"type": "null"}], "default": null, "description": "New full value by field name (full-content mode; mutually exclusive with field_name/old_str/new_str)", "title": "Fields"}, "field_name": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Field to patch (patch mode)", "title": "Field Name"}, "old_str": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Exact existing field text to replace (patch mode; must match exactly once)", "title": "Old Str"}, "new_str": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Replacement field text (patch mode; paired with old_str)", "title": "New Str"}}, "required": ["id"], "title": "update_note_fieldsArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "update_note_fieldsDictOutput", "type": "object"}, "annotations": {"title": "Update Note Fields", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "update_notes", "title": "Update Notes", "description": "Update the fields of multiple existing notes in a single batch. Each entry must include the note ID and the fields to update (partial updates are fine - only specified fields are changed). Failures for individual notes do not affect others. Use dry_run=true to validate all entries and preview which notes would be updated without writing any changes — useful before committing a large bulk edit. Intended for notes the user has asked to modify. Returns summary counts (updated, failed) and a per-note results array with retry hints for recoverable failures.", "inputSchema": {"$defs": {"NoteUpdateEntry": {"description": "A single note to update in a batch.", "properties": {"id": {"description": "The note ID to update", "title": "Id", "type": "integer"}, "fields": {"additionalProperties": {"type": "string"}, "description": "Field values to update as key-value pairs (e.g., {\"Front\": \"new question\", \"Back\": \"new answer\"}). Only specified fields are changed; partial updates are OK.", "title": "Fields", "type": "object"}}, "required": ["id", "fields"], "title": "NoteUpdateEntry", "type": "object"}}, "properties": {"notes": {"description": "Notes to update; each {id, fields}", "items": {"$ref": "#/$defs/NoteUpdateEntry"}, "title": "Notes", "type": "array"}, "dry_run": {"default": false, "description": "Validate and preview without writing any changes", "title": "Dry Run", "type": "boolean"}}, "required": ["notes"], "title": "update_notesArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "update_notesDictOutput", "type": "object"}, "annotations": {"title": "Update Notes", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}, {"name": "gui_add_cards", "title": "Open Add Cards Dialog", "description": "Open Anki Add Cards dialog. For when the user asks to open the Add Cards dialog. This tool simply opens the dialog for manual note creation - it does not pre-fill any fields. For programmatic note creation, use add_note instead.", "inputSchema": {"properties": {}, "title": "gui_add_cardsArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "gui_add_cardsDictOutput", "type": "object"}, "annotations": {"title": "Open Add Cards Dialog", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "gui_browse", "title": "Open Card Browser", "description": "Open Anki Card Browser and search for cards using Anki query syntax. Returns array of card IDs found. For when the user asks to open the browser; not part of a review session. It serves note editing/creation workflows, finding and selecting cards/notes that need editing.", "inputSchema": {"properties": {"query": {"description": "Anki search query to run in the browser", "title": "Query", "type": "string"}}, "required": ["query"], "title": "gui_browseArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "gui_browseDictOutput", "type": "object"}, "annotations": {"title": "Open Card Browser", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "gui_current_card", "title": "Current Reviewer Card", "description": "Get the card currently displayed in Anki's reviewer window: question HTML, note ID, card ID, deck name, note type, and the next-review interval behind each answer button. deckName is the card's home deck; filteredDeckName is always present and is null unless the card is currently being studied from a filtered deck. The answer and the note's fields are omitted by default (no 'answer' or 'fields' key in cardInfo) -- a note's fields can themselves contain the answer (e.g. a Basic note's Back field), so both are gated together. Pass include_answer=True to receive both -- omitting it means a review session need not receive the answer before the user has answered. Returns inReview=false when the reviewer is not active. advancing=true means Anki is still transitioning to the next card after a rating -- the card shown may be the one just answered, so call this again to get the actual next card. Use this when the user is reviewing in Anki's GUI and asks about the card in front of them (for example 'explain this card'), or to find the note behind it before editing. Read-only: by default the user presses the answer buttons themselves. gui_answer_card applies when the user has asked for hands-free rating, after gui_show_answer and an explicit user-confirmed rating. rate_card bypasses the reviewer and leaves it desynced, so it does not apply to a card shown in the reviewer. get_due_cards, present_card and rate_card are for AI-driven review sessions outside the GUI reviewer.", "inputSchema": {"properties": {"include_answer": {"default": false, "description": "Also return the note's fields and rendered answer", "title": "Include Answer", "type": "boolean"}}, "title": "gui_current_cardArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "gui_current_cardDictOutput", "type": "object"}, "annotations": {"title": "Current Reviewer Card", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "gui_deck_browser", "title": "Open Deck Browser", "description": "Open Anki Deck Browser dialog showing all decks. For when the user asks to open the deck browser, to see all decks or manage deck structure; not part of a review session.", "inputSchema": {"properties": {}, "title": "gui_deck_browserArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "gui_deck_browserDictOutput", "type": "object"}, "annotations": {"title": "Open Deck Browser", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "gui_edit_note", "title": "Open Note Editor", "description": "Open Anki note editor dialog for a specific note ID. Allows manual editing of note fields, tags, and cards in the GUI. The note editor is opened in the Anki Browser, which provides full editing capabilities. For when the user asks to edit a note manually in the Anki interface. Programmatic editing is done by update_note_fields.", "inputSchema": {"properties": {"note_id": {"description": "Note to open in the editor", "title": "Note Id", "type": "integer"}}, "required": ["note_id"], "title": "gui_edit_noteArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "gui_edit_noteDictOutput", "type": "object"}, "annotations": {"title": "Open Note Editor", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "gui_select_card", "title": "Select Card in Browser", "description": "Select a specific card in an open Card Browser window. Returns true if browser is open and card was selected, false if browser is not open. For when the user asks to select a card in the browser, in note editing/creation workflows; not part of a review session. The Card Browser must already be open (gui_browse opens it).", "inputSchema": {"properties": {"card_id": {"description": "Card to select in the open browser", "title": "Card Id", "type": "integer"}}, "required": ["card_id"], "title": "gui_select_cardArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "gui_select_cardDictOutput", "type": "object"}, "annotations": {"title": "Select Card in Browser", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "gui_show_answer", "title": "Show Answer in Reviewer", "description": "Flip the card currently on screen in Anki's reviewer to its answer side. Returns inReview=false when the reviewer is not active. advancing=true means Anki is still transitioning to the next card after a rating -- wait and check gui_current_card before flipping. Use this when the user is reviewing in Anki's GUI and asks to reveal or flip the card in front of them. This only changes what is displayed: by default the user presses the answer buttons themselves. gui_answer_card applies when the user has asked for hands-free rating, after this call and an explicit user-confirmed rating. rate_card bypasses the reviewer and leaves it desynced, so it does not apply to a card shown in the reviewer. get_due_cards, present_card and rate_card are for AI-driven review sessions outside the GUI reviewer.", "inputSchema": {"properties": {}, "title": "gui_show_answerArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "gui_show_answerDictOutput", "type": "object"}, "annotations": {"title": "Show Answer in Reviewer", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "gui_show_question", "title": "Show Question in Reviewer", "description": "Show the question side of the card currently on screen in Anki's reviewer. Returns inReview=false when the reviewer is not active. advancing=true means Anki is still transitioning to the next card after a rating -- wait and check gui_current_card before flipping. Use this when the user is reviewing in Anki's GUI and asks to go back to the question side of the card in front of them. This only changes what is displayed: by default the user presses the answer buttons themselves. gui_answer_card applies when the user has asked for hands-free rating, after gui_show_answer and an explicit user-confirmed rating. rate_card bypasses the reviewer and leaves it desynced, so it does not apply to a card shown in the reviewer. get_due_cards, present_card and rate_card are for AI-driven review sessions outside the GUI reviewer.", "inputSchema": {"properties": {}, "title": "gui_show_questionArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "gui_show_questionDictOutput", "type": "object"}, "annotations": {"title": "Show Question in Reviewer", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}, {"name": "gui_undo", "title": "Undo Last Action", "description": "Undo the last action in Anki -- a note edit, a card-management change, or a rating just made in Anki's reviewer. Returns undone=true if there was something to undo. Applies when the user asks to undo. In a hands-free GUI review session it is how a mis-heard or mistaken rating is taken back; rating the card again does not correct a rating, it records a second one. After undoing a reviewer rating, the reviewer only re-shows the undone card once the Anki window regains focus, so a gui_current_card call made immediately afterwards may still report the previous card until the user clicks into Anki.", "inputSchema": {"properties": {}, "title": "gui_undoArguments", "type": "object"}, "outputSchema": {"additionalProperties": true, "title": "gui_undoDictOutput", "type": "object"}, "annotations": {"title": "Undo Last Action", "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false}}];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, mcp-session-id, Last-Event-ID",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMcpResponse(id, resultObj, useSse = false) {
  const payload = {
    jsonrpc: "2.0",
    id: id,
    result: resultObj,
  };
  if (useSse) {
    const sseBody = `event: message\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
    return new Response(sseBody, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

function formatToolResult(id, dataObj, isError = false, useSse = false) {
  return formatMcpResponse(
    id,
    {
      content: [
        {
          type: "text",
          text: JSON.stringify(dataObj, null, 2),
        },
      ],
      structuredContent: dataObj,
      isError: isError,
    },
    useSse
  );
}

async function checkNgrokOnline(ngrokDomain) {
  try {
    // 1. Tenta a rota dedicada do CloudGateway (/health ou /__cloud_health)
    const healthResp = await fetch(`https://${ngrokDomain}/__cloud_health`, {
      method: "GET",
      headers: {
        "ngrok-skip-browser-warning": "true",
        "User-Agent": "AnkiCloudWorker/1.0",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (healthResp.ok) {
      const data = await healthResp.json();
      return { online: true, gateway: true, details: data };
    }

    // 2. Fallback: se a instância atual do Anki estiver rodando direto na 3141 sem o gateway 3142,
    // faz um ping JSON-RPC rápido no próprio AnkiMCP
    if (healthResp.status === 404 || healthResp.status === 405) {
      const errKode = healthResp.headers.get("ngrok-error-code");
      if (errKode) {
        return { online: false, ngrok_error: errKode };
      }
      const rpcPing = await fetch(`https://${ngrokDomain}/`, {
        method: "POST",
        headers: {
          "ngrok-skip-browser-warning": "true",
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "User-Agent": "AnkiCloudWorker/1.0",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "ping-check",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "cloudflare-worker-probe", version: "1.0" },
          },
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (rpcPing.ok) {
        return {
          online: true,
          gateway: false,
          details: { status: "online", note: "Direct AnkiMCP port 3141 active" },
        };
      }
    }
    return { online: false, status: healthResp.status };
  } catch (err) {
    return { online: false, error: String(err) };
  }
}

async function getGitHubActiveRuns(repo, githubToken) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "AnkiCloudWorker/1.0",
  };
  if (githubToken) {
    headers["Authorization"] = `Bearer ${githubToken}`;
  }
  try {
    const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=5`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.workflow_runs || []).filter(
      (r) =>
        r.name === "Anki Cloud Server" &&
        (r.status === "in_progress" || r.status === "queued" || r.status === "waiting")
    );
  } catch (e) {
    return [];
  }
}

async function triggerGitHubDispatch(repo, githubToken, eventType, clientPayload = {}) {
  if (!githubToken) {
    return {
      ok: false,
      error: "Variável secreta GITHUB_TOKEN não configurada no Cloudflare Worker! Configure em Settings -> Variables and Secrets.",
    };
  }
  const url = `https://api.github.com/repos/${repo}/dispatches`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": "AnkiCloudWorker/1.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: clientPayload,
    }),
  });
  if (resp.status === 204 || resp.ok) {
    return { ok: true };
  }
  const txt = await resp.text();
  return { ok: false, status: resp.status, error: txt };
}

async function handleCloudTool(toolName, args, env) {
  const ngrokDomain = env.NGROK_DOMAIN || DEFAULT_CONFIG.NGROK_DOMAIN;
  const repo = env.GITHUB_REPO || DEFAULT_CONFIG.GITHUB_REPO;
  const githubToken = env.GITHUB_TOKEN || "";

  if (toolName === "anki_cloud_status") {
    const waitSeconds = Math.min(25, Math.max(0, Number(args?.wait_seconds || 0)));
    const startTime = Date.now();

    while (true) {
      const probe = await checkNgrokOnline(ngrokDomain);
      if (probe.online) {
        return {
          server_state: "ONLINE",
          ready_for_anki_tools: true,
          ngrok_domain: ngrokDomain,
          ...(probe.details || {}),
        };
      }
      const elapsedSec = (Date.now() - startTime) / 1000;
      if (elapsedSec >= waitSeconds) {
        break;
      }
      await sleep(3000);
    }

    const activeRuns = await getGitHubActiveRuns(repo, githubToken);
    if (activeRuns.length > 0) {
      const run = activeRuns[0];
      return {
        server_state: "STARTING",
        ready_for_anki_tools: false,
        github_run_id: run.id,
        github_status: run.status,
        started_at: run.created_at,
        message:
          "O servidor Anki já está inicializando no GitHub Actions (instalando dependências e sincronizando AnkiWeb). Chame `anki_cloud_status` novamente com `wait_seconds: 25` em alguns instantes!",
      };
    }

    return {
      server_state: "OFFLINE",
      ready_for_anki_tools: false,
      message: "O servidor Anki está desligado. Chame `anki_cloud_start` para ligá-lo!",
    };
  }

  if (toolName === "anki_cloud_start") {
    const durationMinutes = Number(args?.duration_minutes || DEFAULT_CONFIG.DEFAULT_DURATION_MINUTES);
    const waitSeconds = Math.min(25, Math.max(0, Number(args?.wait_seconds ?? 20)));

    // 1. Verifica se já está online
    const initialProbe = await checkNgrokOnline(ngrokDomain);
    if (initialProbe.online) {
      return {
        server_state: "ALREADY_ONLINE",
        ready_for_anki_tools: true,
        message: "O servidor Anki já está online e pronto para uso!",
        ...(initialProbe.details || {}),
      };
    }

    // 2. Verifica se já existe uma execução subindo para não duplicar
    const activeRuns = await getGitHubActiveRuns(repo, githubToken);
    let triggeredNew = false;

    if (activeRuns.length === 0) {
      const dispatch = await triggerGitHubDispatch(repo, githubToken, "start-anki", {
        duration_minutes: durationMinutes,
      });
      if (!dispatch.ok) {
        return {
          server_state: "ERROR_STARTING",
          ready_for_anki_tools: false,
          error: dispatch.error,
        };
      }
      triggeredNew = true;
    }

    // 3. Aguarda até waitSeconds para ver se já fica online
    const startTime = Date.now();
    while ((Date.now() - startTime) / 1000 < waitSeconds) {
      await sleep(3000);
      const probe = await checkNgrokOnline(ngrokDomain);
      if (probe.online) {
        return {
          server_state: "ONLINE",
          ready_for_anki_tools: true,
          triggered_new_run: triggeredNew,
          message: "Servidor Anki iniciado e sincronizado com sucesso! Pode usar todas as ferramentas do Anki agora.",
          ...(probe.details || {}),
        };
      }
    }

    return {
      server_state: "STARTING",
      ready_for_anki_tools: false,
      triggered_new_run: triggeredNew,
      duration_minutes: durationMinutes,
      message:
        "🚀 Ordem de inicialização enviada ao GitHub Actions! O boot completo (Xvfb + Anki + Sync AnkiWeb + Ngrok) leva cerca de 60 a 75 segundos. Chame `anki_cloud_status` com `wait_seconds: 25` para aguardar o término do boot no mesmo chat!",
    };
  }

  if (toolName === "anki_cloud_stop") {
    let gatewayShutdownOk = false;
    try {
      const resp = await fetch(`https://${ngrokDomain}/__cloud_shutdown`, {
        method: "POST",
        headers: {
          "ngrok-skip-browser-warning": "true",
          "User-Agent": "AnkiCloudWorker/1.0",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        gatewayShutdownOk = true;
      }
    } catch (e) {
      // Ignora se já estiver fechado ou sem gateway
    }

    // Também dispara o evento stop-anki no GitHub como garantia
    const dispatch = await triggerGitHubDispatch(repo, githubToken, "stop-anki", {});

    return {
      server_state: "SHUTTING_DOWN",
      graceful_http_signal_sent: gatewayShutdownOk,
      github_stop_workflow_dispatched: dispatch.ok,
      message:
        "🛑 Comando de desligamento enviado! O Anki na nuvem está fazendo o upload final das alterações para o AnkiWeb e desligará o runner em seguida.",
    };
  }

  return { error: `Unknown cloud tool: ${toolName}` };
}

export default {
  async fetch(request, env, ctx) {
    const ngrokDomain = env.NGROK_DOMAIN || DEFAULT_CONFIG.NGROK_DOMAIN;
    const repo = env.GITHUB_REPO || DEFAULT_CONFIG.GITHUB_REPO;
    const githubToken = env.GITHUB_TOKEN || "";

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // 2. Rota amigável de status no navegador (GET /)
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/status")) {
      const accept = request.headers.get("Accept") || "";
      if (!accept.includes("text/event-stream")) {
        const probe = await checkNgrokOnline(ngrokDomain);
        const activeRuns = probe.online ? [] : await getGitHubActiveRuns(repo, githubToken);
        return new Response(
          JSON.stringify(
            {
              proxy: "Anki Cloud MCP Worker (Online 24/7)",
              anki_server_online: probe.online,
              anki_server_starting: activeRuns.length > 0,
              ngrok_domain: ngrokDomain,
              github_repo: repo,
              cached_tools_count: CACHED_TOOLS.length,
              details: probe.details || null,
            },
            null,
            2
          ),
          {
            status: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          }
        );
      }
    }

    // 3. Processamento JSON-RPC do MCP (POST)
    if (request.method === "POST") {
      const rawBody = await request.text();
      let rpc;
      try {
        rpc = JSON.parse(rawBody);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      const accept = request.headers.get("Accept") || "";
      const preferSse = accept.includes("text/event-stream") && !accept.includes("application/json");
      const method = rpc?.method;
      const id = rpc?.id;

      // 3a. Handshake: initialize -> Responde IMEDIATAMENTE em 10ms (mesmo com Anki desligado!)
      if (method === "initialize") {
        return formatMcpResponse(id, CACHED_INIT_RESULT, preferSse);
      }

      // 3b. Notifications (ex: notifications/initialized) -> 202 Accepted imediato
      if (method && method.startsWith("notifications/")) {
        return new Response(null, { status: 202, headers: CORS_HEADERS });
      }

      // 3c. Ping -> Pong imediato
      if (method === "ping") {
        return formatMcpResponse(id, {}, preferSse);
      }

      // 3d. Catálogo de ferramentas: tools/list -> Retorna as 37 tools do Anki + 3 tools Cloud em 10ms!
      if (method === "tools/list") {
        return formatMcpResponse(id, { tools: CACHED_TOOLS }, preferSse);
      }

      // 3e. Prompts / Resources vazios caso o cliente consulte
      if (method === "prompts/list") {
        return formatMcpResponse(id, { prompts: [] }, preferSse);
      }
      if (method === "resources/list") {
        return formatMcpResponse(id, { resources: [] }, preferSse);
      }

      // 3f. Chamada de Ferramenta: tools/call
      if (method === "tools/call") {
        const toolName = rpc?.params?.name || "";
        const toolArgs = rpc?.params?.arguments || {};

        // Se for uma das 3 ferramentas de controle da nuvem, o próprio Worker executa:
        if (["anki_cloud_status", "anki_cloud_start", "anki_cloud_stop"].includes(toolName)) {
          const resData = await handleCloudTool(toolName, toolArgs, env);
          return formatToolResult(id, resData, false, preferSse);
        }

        // Se for uma ferramenta normal do Anki (ex: list_decks, find_notes, add_note):
        // Tenta encaminhar para o Ngrok
        try {
          const upstreamHeaders = {
            "ngrok-skip-browser-warning": "true",
            "Content-Type": "application/json",
            Accept: request.headers.get("Accept") || "application/json, text/event-stream",
            "User-Agent": "AnkiCloudWorker/1.0",
          };
          const sessionId = request.headers.get("mcp-session-id");
          if (sessionId) {
            upstreamHeaders["mcp-session-id"] = sessionId;
          }
          if (env.ANKI_MCP_API_KEY) {
            upstreamHeaders["Authorization"] = `Bearer ${env.ANKI_MCP_API_KEY}`;
          }

          const upstreamResp = await fetch(`https://${ngrokDomain}${url.pathname}`, {
            method: "POST",
            headers: upstreamHeaders,
            body: rawBody,
            signal: AbortSignal.timeout(55000),
          });

          const ngrokErr = upstreamResp.headers.get("ngrok-error-code");
          if (!ngrokErr && upstreamResp.status !== 404 && upstreamResp.status !== 502) {
            const respHeaders = new Headers(upstreamResp.headers);
            for (const [k, v] of Object.entries(CORS_HEADERS)) {
              respHeaders.set(k, v);
            }
            return new Response(upstreamResp.body, {
              status: upstreamResp.status,
              headers: respHeaders,
            });
          }
        } catch (err) {
          // Servidor offline ou túnel fechado -> segue para Auto-Wake abaixo!
        }

        // AUTO-WAKE: O servidor Anki estava desligado quando a IA tentou usar uma tool do Anki!
        const activeRuns = await getGitHubActiveRuns(repo, githubToken);
        let autoTriggered = false;
        if (activeRuns.length === 0 && githubToken) {
          const dispatch = await triggerGitHubDispatch(repo, githubToken, "start-anki", {
            duration_minutes: DEFAULT_CONFIG.DEFAULT_DURATION_MINUTES,
          });
          autoTriggered = dispatch.ok;
        }

        // Espera rapidamente 15s caso o servidor já estivesse quase pronto
        const wakeStart = Date.now();
        while ((Date.now() - wakeStart) / 1000 < 15) {
          await sleep(3000);
          const probe = await checkNgrokOnline(ngrokDomain);
          if (probe.online) {
            // Ficou online durante a espera! Repassa a chamada original e entrega o resultado!
            const retryResp = await fetch(`https://${ngrokDomain}${url.pathname}`, {
              method: "POST",
              headers: {
                "ngrok-skip-browser-warning": "true",
                "Content-Type": "application/json",
                Accept: request.headers.get("Accept") || "application/json, text/event-stream",
                "User-Agent": "AnkiCloudWorker/1.0",
              },
              body: rawBody,
            });
            const respHeaders = new Headers(retryResp.headers);
            for (const [k, v] of Object.entries(CORS_HEADERS)) {
              respHeaders.set(k, v);
            }
            return new Response(retryResp.body, {
              status: retryResp.status,
              headers: respHeaders,
            });
          }
        }

        return formatToolResult(
          id,
          {
            server_state: "STARTING_AUTOMATICALLY",
            auto_wake_triggered: autoTriggered,
            already_booting: activeRuns.length > 0,
            next_action_required:
              "O servidor Anki na nuvem estava desligado e foi ACIONADO AUTOMATICAMENTE agora no GitHub Actions! O boot completo leva ~60 segundos. Chame a ferramenta `anki_cloud_status` com `wait_seconds: 25` uma ou duas vezes até retornar ONLINE, e então repita sua chamada para `" +
              toolName +
              "`!",
          },
          false,
          preferSse
        );
      }
    }

    // Fallback para outras requisições
    return new Response(JSON.stringify({ status: "ok", message: "Anki Cloud MCP Worker" }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  },
};
