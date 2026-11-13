// SPDX-License-Identifier: GPL-3.0-only
// Race independent source discovery paths. A fast failure is not a winner,
// and the slower successful response is still made available for fallback.
export async function raceSourceQueries(queries) {
  if (!Array.isArray(queries) || queries.length < 2)
    throw new TypeError('At least two source queries are required');
  const started = queries.map(({ route, run }) => Promise.resolve().then(run).then(data => {
    if (!Array.isArray(data?.variants) || !data.variants.length)
      throw Object.assign(new Error('Empty media source list'), { code: 'SOURCE_UNAVAILABLE' });
    return { route, variants: data.variants, data };
  }));
  let winner;
  try {
    winner = await Promise.any(started);
  } catch {
    const failures = await Promise.allSettled(started);
    const appIndex = queries.findIndex(q => q.route === 'app');
    const preferred = appIndex >= 0 ? failures[appIndex] : failures[0];
    throw preferred?.reason || failures[0]?.reason ||
      Object.assign(new Error('No source available'), { code: 'SOURCE_UNAVAILABLE' });
  }
  // Retain late results. All settling promises have handlers even if
  // the caller leaves the page before another request finishes.
  const later = Promise.allSettled(started).then(outcomes =>
    outcomes.filter(result => result.status === 'fulfilled' &&
      result.value.route !== winner.route).map(result => result.value));
  return { winner, later };
}
