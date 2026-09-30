// One row per cron tick, so the suite can count ticks.
export const tick = async (init) => {
  await init.db.insert('fence_ticks', { trigger_name: init.triggerName });
};
