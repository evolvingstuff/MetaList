// A suite runs its cases, removes its fixture whatever happened, and reports
// the cases' own failure first: a cleanup failure on top of it (a reload left
// in flight by the failed step, say) is logged, not substituted for it.
export async function runThenCleanUp(label, run, cleanUp) {
  const [outcome] = await Promise.allSettled([run()]);
  const [cleanup] = await Promise.allSettled([cleanUp()]);
  if (outcome.status === 'rejected') {
    if (cleanup.status === 'rejected') console.error(`${label} cleanup also failed: ${cleanup.reason.message}`);
    throw outcome.reason;
  }
  if (cleanup.status === 'rejected') throw cleanup.reason;
}
