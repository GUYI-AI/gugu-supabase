// Each reservation is returned once. Do not replay a failed or uncertain batch.
export async function runPushBatch(database, provider, environment, log = () => {}) {
  const reserved = await database.query('SELECT identity.mobile_push_reserve($1,20) AS id', [environment])
  for (const { id } of reserved.rows) {
    let result = { outcome: 'suppressed', invalidBefore: null }
    try {
      const admitted = await database.query('SELECT identity.mobile_push_admit($1) AS admitted', [id])
      if (!admitted.rows[0]?.admitted) continue
      await database.query('BEGIN')
      const prepared = await database.query('SELECT identity.mobile_push_prepare($1) AS endpoint', [id])
      const endpoint = prepared.rows[0]?.endpoint
      if (endpoint) result = await provider.send(endpoint)
      await database.query('SELECT identity.mobile_push_finish($1,$2,$3)', [id, result.outcome, result.invalidBefore])
      await database.query('COMMIT')
      log({ notificationId: id, outcome: result.outcome })
    } catch {
      await database.query('ROLLBACK')
      // The earlier committed reservation/cursor remains consumed, even when
      // recording an outcome fails. Never infer "not sent" from an exception.
      log({ notificationId: id, outcome: 'unknown' })
    }
  }
  return reserved.rows.length
}
