// Each reservation is returned once. Do not replay a failed or uncertain batch.
export async function runPushBatch(database, providers, environment, log = () => {}, progress = async () => {}, stopping = () => false) {
  const reserved = await database.query('SELECT identity.mobile_push_reserve($1,$2::text[],20) AS id', [environment, Object.keys(providers)])
  await progress()
  for (const { id } of reserved.rows) {
    if (stopping()) break
    let result = { outcome: 'suppressed', invalidBefore: null }
    try {
      const admitted = await database.query('SELECT identity.mobile_push_admit($1) AS admitted', [id])
      if (!admitted.rows[0]?.admitted) continue
      await database.query('BEGIN')
      const prepared = await database.query('SELECT identity.mobile_push_prepare($1) AS endpoint', [id])
      const endpoint = prepared.rows[0]?.endpoint
      if (endpoint) {
        const provider = providers[endpoint.provider]
        if (!provider) throw new Error('Unconfigured push provider')
        result = await provider.send(endpoint)
      }
      await database.query('SELECT identity.mobile_push_finish($1,$2,$3,$4)', [id, result.outcome, result.invalidBefore, result.providerMessageId ?? null])
      await database.query('COMMIT')
      log({ notificationId: id, outcome: result.outcome })
    } catch {
      await database.query('ROLLBACK')
      // The earlier committed reservation/cursor remains consumed, even when
      // recording an outcome fails. Never infer "not sent" from an exception.
      log({ notificationId: id, outcome: 'unknown' })
    } finally { await progress() }
  }
  return reserved.rows.length
}
