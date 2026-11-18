import type pg from 'pg'

// Only the observer owns this session lock. Contender connections must never
// acquire it: they run inside the observer's fixture and would wait on it.
const held = new WeakSet<pg.Client>()
const lock = "hashtextextended('account-deletion-committed-fixtures',0)"

export async function beginDeletionFixture(db: pg.Client) {
  const previous = (await db.query("SELECT current_setting('lock_timeout') value")).rows[0].value as string
  try {
    await db.query("SELECT set_config('lock_timeout','20s',false)")
    try { await db.query(`SELECT pg_advisory_lock(${lock})`) }
    catch (cause) { throw new Error('Deletion fixture mutex was not acquired within 20 seconds', { cause }) }
    held.add(db)
  } finally {
    await db.query("SELECT set_config('lock_timeout',$1,false)", [previous])
  }
  try { await db.query('BEGIN') }
  catch (error) { await endDeletionFixture(db); throw error }
}

export async function endDeletionFixture(db: pg.Client) {
  try { await db.query('ROLLBACK') }
  finally {
    if (held.delete(db)) {
      const released = (await db.query(`SELECT pg_advisory_unlock(${lock}) released`)).rows[0].released
      if (!released) throw new Error('Deletion fixture mutex ownership was lost')
    }
  }
}
