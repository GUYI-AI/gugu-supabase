/**
 * Account revisions are written when a transaction commits (chat.flush_user_revisions, a deferred constraint
 * trigger). A case that runs inside BEGIN…ROLLBACK and reads revisions, heads or user events before it ends opens its
 * transaction with this instead of a bare BEGIN: every statement then flushes what it published. No product path
 * reads its own revisions before committing.
 */
export const BEGIN_READING_REVISIONS = 'BEGIN; SET CONSTRAINTS chat.pending_user_revisions_flush IMMEDIATE'

/**
 * Flushes what the transaction has published so far, as a commit would, and returns to deferring. For cases that count
 * wakes per commit, or that call a function which itself runs `SET CONSTRAINTS ALL DEFERRED` (create_gugu_group).
 */
export const FLUSH_REVISIONS = 'SET CONSTRAINTS chat.pending_user_revisions_flush IMMEDIATE; SET CONSTRAINTS chat.pending_user_revisions_flush DEFERRED'
