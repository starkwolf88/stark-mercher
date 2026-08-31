// Timing simulation of the Stark Mercher bot over 7 days.
// Replicates the real humanisation layers from humanised-delay.ts,
// click-jitter.ts, session.ts, and session-profile.ts without needing
// the titan SDK or game world.
//
// Simulates the mercher's action cycle: open GE → check stale → abort/sell/buy
// flows → idle → short break → nightly sleep, with all delay layers.
//
// Usage: node tests/timing-sim.mjs [--days N] [--accounts N] [--seed S]
//
// Output: timing analysis report showing delay distributions, click-interval
// histograms, autocorrelation, session/break patterns, and detectable patterns.

// ─── PRNG (mulberry32, same as humanised-delay.ts) ──────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function sampleInt(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }
function sampleFloat(rng, min, max) { return min + rng() * (max - min); }
function sampleBool(rng, chance) { return rng() < chance; }

// ─── String hash (djb2, same as humanised-delay.ts) ─────────────────
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) >>> 0;
}

// ─── Delay profile generation (replicated from humanised-delay.ts) ──
function generateDelayProfile(accountName) {
  const rng = mulberry32(hashString(accountName));
  return {
    reactionBias: sampleFloat(rng, -1, 1),
    jitterTicks: sampleInt(rng, 1, 2),
    hesitationMultiplier: sampleFloat(rng, 1.5, 3.0),
    outlierChance: sampleFloat(rng, 0.03, 0.08),
    outlierMultiplier: sampleFloat(rng, 1.3, 1.8),
    outlierNestedChance: sampleFloat(rng, 0.15, 0.25),
    outlierNestedMultiplier: sampleFloat(rng, 1.3, 1.5),
    jitterAmplifyChance: sampleFloat(rng, 0.005, 0.02),
    jitterAmplifyMinTicks: sampleInt(rng, 5, 15),
    jitterAmplifyMaxTicks: sampleInt(rng, 15, 30),
  };
}

// ─── Click jitter profile (replicated from click-jitter.ts) ─────────
function generateClickJitterProfile(delayProfile) {
  const base = Math.round(2 + delayProfile.reactionBias * 1.5);
  const reactionJitterClientTicks = Math.max(1, Math.min(4, base));
  const doubleClickChance = Math.max(3, Math.min(10, 3 + (delayProfile.jitterTicks / 2) * 3.5));
  return { reactionJitterClientTicks, doubleClickChance };
}

// ─── Session profile (replicated from session-profile.ts) ───────────
function generateSessionProfile(accountName) {
  // FNV-1a hash (same as session-profile.ts)
  let h = 2166136261;
  for (let i = 0; i < accountName.length; i++) {
    h ^= accountName.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const seed = h >>> 0;
  const rng = mulberry32(seed);

  return {
    nightlySleepLengthBase: sampleInt(rng, 210, 390),
    nightlySleepLengthVariance: sampleInt(rng, 15, 90),
    nightlyWakeBase: sampleInt(rng, 390, 450),
    nightlyWakeVariance: sampleInt(rng, 15, 60),
    nightlyWakeLateChance: 0.10,
    nightlyWakeLateExtraMin: sampleInt(rng, 30, 90),
    nightlyWeekendLate: sampleBool(rng, 0.75),
    nightlyWeekendWakeShift: sampleInt(rng, 30, 90),
    shortBreakBaseMin: 2,
    shortBreakBaseMax: 5,
    shortBreakVarianceMin: 1,
    shortBreakVarianceMax: 1,
    longTailChance: 0.10,
    longTailMin: 1,
    longTailMax: 5,
    longTailNestedChance: 0.10,
  };
}

// ─── createDelay() (replicated from humanised-delay.ts) ─────────────
// Includes the rare distraction event that bypasses max.
const DISTRACTION_CHANCE = 0.001; // 0.1%
const DISTRACTION_MIN_TICKS = 20;
const DISTRACTION_MAX_TICKS = 60;

function createDelay(rng, profile, base, triggerChance, max) {
  const b = Math.max(1, Math.floor(base));
  let delay = b;

  // ALWAYS: reaction bias
  const biasShift = Math.round(profile.reactionBias * 2);
  delay = Math.max(1, delay + biasShift);

  // ALWAYS: jitter
  if (profile.jitterTicks > 0) {
    const jitter = sampleInt(rng, -profile.jitterTicks, profile.jitterTicks);
    delay = Math.max(1, delay + jitter);
  }

  // TRIGGERED: hesitation, outlier, amplify
  if (rng() * 100 <= triggerChance) {
    delay = Math.max(1, Math.round(delay * profile.hesitationMultiplier));

    if (rng() < profile.outlierChance) {
      delay = Math.round(delay * profile.outlierMultiplier);
      if (rng() < profile.outlierNestedChance) {
        delay = Math.round(delay * profile.outlierNestedMultiplier);
      }
    }

    if (rng() < profile.jitterAmplifyChance) {
      delay += sampleInt(rng, profile.jitterAmplifyMinTicks, profile.jitterAmplifyMaxTicks);
    }
  }

  // RARE: distraction (bypasses max)
  let distracted = false;
  if (rng() < DISTRACTION_CHANCE) {
    delay += sampleInt(rng, DISTRACTION_MIN_TICKS, DISTRACTION_MAX_TICKS);
    distracted = true;
  }

  const result = Math.max(1, delay);
  if (distracted) return { ticks: result, distracted: true };
  return { ticks: max !== undefined && max > 0 ? Math.min(result, max) : result, distracted: false };
}

// ─── Click jitter (replicated from click-jitter.ts) ─────────────────
function clickJitterMs(rng, clickProfile) {
  const maxTicks = clickProfile.reactionJitterClientTicks;
  const clientTicks = sampleInt(rng, 0, Math.max(0, maxTicks));
  return clientTicks * 20; // ~20ms per client tick
}

// ─── Session/break logic (replicated from session.ts) ───────────────
const TICKS_PER_MINUTE = 100; // OSRS: 100 ticks/min (600ms each)
const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 1440 * MS_PER_MINUTE;

function sampleShortBreakDuration(rng, sessionProfile) {
  const base = sampleInt(rng, sessionProfile.shortBreakBaseMin, sessionProfile.shortBreakBaseMax);
  const variance = sampleInt(rng, sessionProfile.shortBreakVarianceMin, sessionProfile.shortBreakVarianceMax);
  let total = base + variance;
  if (rng() < sessionProfile.longTailChance) {
    total += sampleInt(rng, sessionProfile.longTailMin, sessionProfile.longTailMax);
    if (rng() < sessionProfile.longTailNestedChance) {
      total += sampleInt(rng, sessionProfile.longTailMin, sessionProfile.longTailMax);
    }
  }
  return total * MS_PER_MINUTE;
}

function sampleNightlySleepMinutes(rng, sessionProfile) {
  if (rng() < 0.05) return sampleInt(rng, 300, 420); // 5% outlier
  const base = sessionProfile.nightlySleepLengthBase;
  const variance = sessionProfile.nightlySleepLengthVariance;
  const effectiveVariance = Math.min(variance, 420 - base);
  return base + sampleInt(rng, 0, Math.max(0, effectiveVariance));
}

// ─── Pre-logout idle delay (replicated from session.ts) ─────────────
function samplePreLogoutDelay(rng) {
  let delay = 5 + Math.floor(rng() * 16); // 5-20 ticks
  if (rng() < 0.20) delay += 3;
  if (rng() < 0.10) delay += 1 + Math.floor(rng() * 10);
  if (rng() < 0.01) delay += 5 + Math.floor(rng() * 11);
  return delay;
}

// ─── Mercher action cycle ────────────────────────────────────────────
// The mercher's cycle: open GE → check stale offers → abort/sell/buy → idle
// Each flow has multiple steps with createDelay() calls.
// When all slots are occupied and nothing to do, idle until short break.
// Nightly sleep logs out for 3.5-6.5h.

// Buy flow steps (from buy-offer.ts): ~21 steps, each with createDelay
// base=1 or 2, triggerChance=35, max=5
const BUY_STEPS = [
  { base: 1, trigger: 35, max: 5, action: 'buy_step0_resolve' },
  { base: 2, trigger: 35, max: 5, action: 'buy_step1_click_buy' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step2_wait_config' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step3_type_search' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step4_wait_results' },
  { base: 2, trigger: 35, max: 5, action: 'buy_step5_click_result' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step6_validate_item' },
  { base: 2, trigger: 35, max: 5, action: 'buy_step7_click_qty' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step8_type_qty' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step9_wait_qty' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step10_enter_qty' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step11_wait_price' },
  { base: 2, trigger: 35, max: 5, action: 'buy_step12_click_price' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step13_wait_price_input' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step14_type_price' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step15_wait_price_submit' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step16_enter_price' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step17_validate' },
  { base: 2, trigger: 35, max: 5, action: 'buy_step18_click_confirm' },
  { base: 1, trigger: 35, max: 5, action: 'buy_step19_wait_confirm' },
  { base: 2, trigger: 35, max: 5, action: 'buy_step20_done' },
];

// Sell flow steps (from sell-offer.ts): ~13 steps
const SELL_STEPS = [
  { base: 1, trigger: 35, max: 5, action: 'sell_step0_resolve' },
  { base: 2, trigger: 35, max: 5, action: 'sell_step1_click_sell' },
  { base: 1, trigger: 35, max: 5, action: 'sell_step2_wait_config' },
  { base: 2, trigger: 35, max: 5, action: 'sell_step3_click_item' },
  { base: 1, trigger: 35, max: 5, action: 'sell_step4_validate' },
  { base: 1, trigger: 35, max: 5, action: 'sell_step5_check_price' },
  { base: 2, trigger: 35, max: 5, action: 'sell_step6_click_price' },
  { base: 1, trigger: 35, max: 5, action: 'sell_step7_wait_price' },
  { base: 1, trigger: 35, max: 5, action: 'sell_step8_type_price' },
  { base: 1, trigger: 35, max: 5, action: 'sell_step9_wait_price' },
  { base: 1, trigger: 35, max: 5, action: 'sell_step10_enter_price' },
  { base: 1, trigger: 35, max: 5, action: 'sell_step11_validate' },
  { base: 2, trigger: 35, max: 5, action: 'sell_step12_click_confirm' },
];

// Abort flow steps (from abort-offer.ts): ~9 steps
const ABORT_STEPS = [
  { base: 1, trigger: 35, max: 5, action: 'abort_step0_verify' },
  { base: 2, trigger: 35, max: 5, action: 'abort_step1_click_slot' },
  { base: 1, trigger: 35, max: 5, action: 'abort_step2_wait_detail' },
  { base: 2, trigger: 35, max: 5, action: 'abort_step3_click_abort' },
  { base: 1, trigger: 35, max: 5, action: 'abort_step4_wait_confirm' },
  { base: 2, trigger: 35, max: 5, action: 'abort_step5_click_back' },
  { base: 1, trigger: 35, max: 5, action: 'abort_step6_wait_main' },
  { base: 2, trigger: 35, max: 5, action: 'abort_step7_click_collect' },
  { base: 1, trigger: 35, max: 5, action: 'abort_step8_done' },
];

// Auto-loop transition delays (from auto-loop.ts)
const FLOW_END_DELAY = { base: 1, trigger: 40, max: 12 };
const OPEN_GE_DELAY = { base: 2, trigger: 30, max: 8 };
const COLLECT_DELAY = { base: 2, trigger: 40, max: 8 };
const IDLE_DELAY = { base: 1, trigger: 100, max: 20 };

// ─── Simulation ──────────────────────────────────────────────────────

function createBot(accountName, seed) {
  const delayProfile = generateDelayProfile(accountName);
  const clickProfile = generateClickJitterProfile(delayProfile);
  const sessionProfile = generateSessionProfile(accountName);

  return {
    accountName,
    delayProfile,
    clickProfile,
    sessionProfile,
    rng: mulberry32(seed + 100),
    tick: 0,
    // Session state
    sessionPlayStartMs: 0,
    nightlyBreakTargetMs: -1,
    nightlySleepMinutes: 0,
    // Break state
    breakPhase: 'none', // 'none' | 'logging_out' | 'logged_out' | 'logging_in'
    breakType: 'none',
    breakTargetEndMs: 0,
    // Idle/break trigger
    loopIdleForBreak: false,
    loopIdleSinceTick: -1,
    shortBreakDelayTicks: -1,
    // GE slots (simulated)
    slots: [null, null, null], // null = empty, {type, item} = occupied
    // Logging
    actionLog: [],   // {tick, action, baseDelay, finalDelay, distracted, triggerFired}
    clickLog: [],    // {tick, action, msOffset}
    breakLog: [],    // {startTick, durationMs, type}
    delayLog: [],    // {tick, base, trigger, max, result, distracted}
    // Stats
    buyFlows: 0,
    sellFlows: 0,
    abortFlows: 0,
    distractions: 0,
  };
}

function scheduleNightlyBreak(bot) {
  const p = bot.sessionProfile;
  const sleepMin = sampleNightlySleepMinutes(bot.rng, p);
  // Simplified: bedtime = now + (16h - sleep) — simulates a ~16h day
  const wakeOffsetMin = p.nightlyWakeBase + sampleInt(bot.rng, -p.nightlyWakeVariance, p.nightlyWakeVariance);
  // Just schedule 16h from session start as a simplification
  bot.nightlyBreakTargetMs = bot.sessionPlayStartMs + (16 * 60 * MS_PER_MINUTE);
  bot.nightlySleepMinutes = sleepMin;
}

function runFlow(bot, steps, flowType) {
  for (const step of steps) {
    const result = createDelay(bot.rng, bot.delayProfile, step.base, step.trigger, step.max);
    const triggerFired = bot.rng() * 100 <= step.trigger; // approx — actual roll is inside createDelay

    bot.actionLog.push({
      tick: bot.tick,
      action: step.action,
      baseDelay: step.base,
      finalDelay: result.ticks,
      distracted: result.distracted,
      triggerFired,
    });

    bot.delayLog.push({
      tick: bot.tick,
      base: step.base,
      trigger: step.trigger,
      max: step.max,
      result: result.ticks,
      distracted: result.distracted,
    });

    if (result.distracted) bot.distractions++;

    // Click at jittered offset
    bot.clickLog.push({
      tick: bot.tick,
      action: step.action,
      ms: clickJitterMs(bot.rng, bot.clickProfile),
    });

    // Advance ticks
    bot.tick += result.ticks;
  }

  if (flowType === 'buy') bot.buyFlows++;
  else if (flowType === 'sell') bot.sellFlows++;
  else if (flowType === 'abort') bot.abortFlows++;
}

function runAutoLoopTick(bot) {
  // Simplified mercher auto-loop:
  // 1. If GE not open, open it (open_ge delay)
  // 2. Check for stale offers → abort flow
  // 3. Sell scan → sell flow
  // 4. Buy scan → buy flow
  // 5. If nothing to do → idle delay, signal break

  // Open GE
  const openResult = createDelay(bot.rng, bot.delayProfile, OPEN_GE_DELAY.base, OPEN_GE_DELAY.trigger, OPEN_GE_DELAY.max);
  bot.delayLog.push({ tick: bot.tick, base: OPEN_GE_DELAY.base, trigger: OPEN_GE_DELAY.trigger, max: OPEN_GE_DELAY.max, result: openResult.ticks, distracted: openResult.distracted });
  if (openResult.distracted) bot.distractions++;
  bot.clickLog.push({ tick: bot.tick, action: 'auto_open_ge', ms: clickJitterMs(bot.rng, bot.clickProfile) });
  bot.tick += openResult.ticks;

  // Simulate slot state: randomly some slots are occupied, some empty
  // In reality, offers fill over time. We simulate a simplified model:
  // - Start with 0-2 slots occupied
  // - Each flow fills/empties a slot
  // - Randomly abort stale offers

  // Check for stale offers (random chance to abort an occupied slot)
  for (let i = 0; i < 3; i++) {
    if (bot.slots[i] && bot.rng() < 0.15) {
      // Abort this slot
      runFlow(bot, ABORT_STEPS, 'abort');
      bot.slots[i] = null;

      // Flow-end delay
      const fe = createDelay(bot.rng, bot.delayProfile, FLOW_END_DELAY.base, FLOW_END_DELAY.trigger, FLOW_END_DELAY.max);
      bot.delayLog.push({ tick: bot.tick, base: FLOW_END_DELAY.base, trigger: FLOW_END_DELAY.trigger, max: FLOW_END_DELAY.max, result: fe.ticks, distracted: fe.distracted });
      if (fe.distracted) bot.distractions++;
      bot.tick += fe.ticks;
      return;
    }
  }

  // Sell scan: if there's an empty slot and "inventory items" (simulated)
  const emptySlot = bot.slots.findIndex(s => s === null);
  if (emptySlot >= 0 && bot.rng() < 0.4) {
    // Sell flow
    runFlow(bot, SELL_STEPS, 'sell');
    bot.slots[emptySlot] = { type: 'sell', item: 'sim_item' };

    // Flow-end delay
    const fe = createDelay(bot.rng, bot.delayProfile, FLOW_END_DELAY.base, FLOW_END_DELAY.trigger, FLOW_END_DELAY.max);
    bot.delayLog.push({ tick: bot.tick, base: FLOW_END_DELAY.base, trigger: FLOW_END_DELAY.trigger, max: FLOW_END_DELAY.max, result: fe.ticks, distracted: fe.distracted });
    if (fe.distracted) bot.distractions++;
    bot.tick += fe.ticks;
    return;
  }

  // Buy scan: if there's an empty slot and coins available
  if (emptySlot >= 0 && bot.rng() < 0.5) {
    // Buy flow
    runFlow(bot, BUY_STEPS, 'buy');
    bot.slots[emptySlot] = { type: 'buy', item: 'sim_item' };

    // Flow-end delay
    const fe = createDelay(bot.rng, bot.delayProfile, FLOW_END_DELAY.base, FLOW_END_DELAY.trigger, FLOW_END_DELAY.max);
    bot.delayLog.push({ tick: bot.tick, base: FLOW_END_DELAY.base, trigger: FLOW_END_DELAY.trigger, max: FLOW_END_DELAY.max, result: fe.ticks, distracted: fe.distracted });
    if (fe.distracted) bot.distractions++;
    bot.tick += fe.ticks;
    return;
  }

  // Collect from completed slots (random chance)
  for (let i = 0; i < 3; i++) {
    if (bot.slots[i] && bot.rng() < 0.1) {
      const cd = createDelay(bot.rng, bot.delayProfile, COLLECT_DELAY.base, COLLECT_DELAY.trigger, COLLECT_DELAY.max);
      bot.delayLog.push({ tick: bot.tick, base: COLLECT_DELAY.base, trigger: COLLECT_DELAY.trigger, max: COLLECT_DELAY.max, result: cd.ticks, distracted: cd.distracted });
      if (cd.distracted) bot.distractions++;
      bot.clickLog.push({ tick: bot.tick, action: 'auto_collect', ms: clickJitterMs(bot.rng, bot.clickProfile) });
      bot.tick += cd.ticks;
      bot.slots[i] = null;
      return;
    }
  }

  // Nothing to do — idle
  const idleResult = createDelay(bot.rng, bot.delayProfile, IDLE_DELAY.base, IDLE_DELAY.trigger, IDLE_DELAY.max);
  bot.delayLog.push({ tick: bot.tick, base: IDLE_DELAY.base, trigger: IDLE_DELAY.trigger, max: IDLE_DELAY.max, result: idleResult.ticks, distracted: idleResult.distracted });
  if (idleResult.distracted) bot.distractions++;
  bot.tick += idleResult.ticks;

  // Signal idle for break
  bot.loopIdleForBreak = true;
  if (bot.loopIdleSinceTick < 0) {
    bot.loopIdleSinceTick = bot.tick;
    bot.shortBreakDelayTicks = samplePreLogoutDelay(bot.rng);
  }
}

function simulateAccount(accountName, seed, totalTicks) {
  const bot = createBot(accountName, seed);
  bot.sessionPlayStartMs = Date.now(); // wall-clock reference for nightly scheduling
  scheduleNightlyBreak(bot);

  // Start with some random slots occupied
  for (let i = 0; i < 3; i++) {
    if (bot.rng() < 0.5) bot.slots[i] = { type: bot.rng() < 0.5 ? 'buy' : 'sell', item: 'init' };
  }

  while (bot.tick < totalTicks) {
    // ── Break handling ──
    if (bot.breakPhase === 'logged_out') {
      const nowMs = bot.sessionPlayStartMs + bot.tick * 600;
      if (nowMs >= bot.breakTargetEndMs) {
        // Break over — log back in
        bot.breakPhase = 'none';
        bot.breakType = 'none';
        bot.loopIdleForBreak = false;
        bot.loopIdleSinceTick = -1;
        bot.shortBreakDelayTicks = -1;
        // Reschedule nightly if it was nightly
        if (bot.breakType === 'nightly') {
          bot.sessionPlayStartMs = nowMs;
          scheduleNightlyBreak(bot);
        }
      } else {
        bot.tick++;
        continue;
      }
    }

    // Check for nightly break
    const nowMs = bot.sessionPlayStartMs + bot.tick * 600;
    if (bot.breakPhase === 'none' && bot.nightlyBreakTargetMs > 0 && nowMs >= bot.nightlyBreakTargetMs) {
      bot.breakPhase = 'logged_out';
      bot.breakType = 'nightly';
      const sleepMs = bot.nightlySleepMinutes * MS_PER_MINUTE;
      bot.breakTargetEndMs = bot.nightlyBreakTargetMs + sleepMs;
      bot.breakLog.push({ startTick: bot.tick, durationMs: sleepMs, type: 'nightly' });
      bot.nightlyBreakTargetMs = nowMs + 24 * 60 * MS_PER_MINUTE; // next day
      continue;
    }

    // Check for short break (idle delay elapsed)
    if (bot.breakPhase === 'none' && bot.loopIdleForBreak && bot.loopIdleSinceTick >= 0) {
      const elapsed = bot.tick - bot.loopIdleSinceTick;
      if (elapsed >= bot.shortBreakDelayTicks) {
        const duration = sampleShortBreakDuration(bot.rng, bot.sessionProfile);
        bot.breakPhase = 'logged_out';
        bot.breakType = 'short';
        bot.breakTargetEndMs = nowMs + duration;
        bot.breakLog.push({ startTick: bot.tick, durationMs: duration, type: 'short' });
        bot.loopIdleForBreak = false;
        bot.loopIdleSinceTick = -1;
        bot.shortBreakDelayTicks = -1;
        continue;
      }
    }

    // Run auto-loop
    runAutoLoopTick(bot);
  }

  return {
    accountName,
    buyFlows: bot.buyFlows,
    sellFlows: bot.sellFlows,
    abortFlows: bot.abortFlows,
    distractions: bot.distractions,
    actionLog: bot.actionLog,
    clickLog: bot.clickLog,
    breakLog: bot.breakLog,
    delayLog: bot.delayLog,
  };
}

// ─── Pattern analysis ────────────────────────────────────────────────

function analyzeResults(results) {
  console.log('\n' + '='.repeat(80));
  console.log('  STARK MERCHER TIMING SIMULATION ANALYSIS — 7 DAYS');
  console.log('='.repeat(80) + '\n');

  for (const result of results) {
    console.log(`\n─ Account: ${result.accountName} ${'─'.repeat(Math.max(0, 60 - result.accountName.length))}`);
    console.log(`  Buy flows: ${result.buyFlows}  |  Sell flows: ${result.sellFlows}  |  Abort flows: ${result.abortFlows}`);
    console.log(`  Distractions: ${result.distractions}  |  Breaks: ${result.breakLog.length}`);
    console.log(`  Total clicks logged: ${result.clickLog.length}`);
    console.log(`  Total delays logged: ${result.delayLog.length}`);

    // ── Delay distribution (the key metric for this bot) ──
    console.log('\n  DELAY DISTRIBUTION (ticks):');
    const delayValues = result.delayLog.map(d => d.result);
    const delayBins = {};
    for (const v of delayValues) {
      const bin = v <= 5 ? v : v <= 10 ? '6-10' : v <= 20 ? '11-20' : v <= 40 ? '21-40' : '41+';
      const key = String(bin);
      delayBins[key] = (delayBins[key] || 0) + 1;
    }
    const delayOrder = ['1', '2', '3', '4', '5', '6-10', '11-20', '21-40', '41+'];
    const maxDelayCount = Math.max(...Object.values(delayBins));
    for (const bin of delayOrder) {
      if (delayBins[bin] === undefined) continue;
      const pct = (delayBins[bin] / delayValues.length * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(delayBins[bin] / maxDelayCount * 40));
      console.log(`    ${bin.padStart(5)}t: ${String(delayBins[bin]).padStart(6)} (${pct.padStart(5)}%) ${bar}`);
    }

    // Delay stats
    const dMean = delayValues.reduce((a, b) => a + b, 0) / delayValues.length;
    const dSorted = [...delayValues].sort((a, b) => a - b);
    const dMedian = dSorted[Math.floor(dSorted.length / 2)];
    const dP5 = dSorted[Math.floor(dSorted.length * 0.05)];
    const dP95 = dSorted[Math.floor(dSorted.length * 0.95)];
    const dP99 = dSorted[Math.floor(dSorted.length * 0.99)];
    const dMin = dSorted[0];
    const dMax = dSorted[dSorted.length - 1];
    const dVar = delayValues.reduce((s, v) => s + (v - dMean) ** 2, 0) / delayValues.length;
    const dStdev = Math.sqrt(dVar);
    const dCv = dStdev / dMean;
    console.log(`    mean=${dMean.toFixed(2)}t  median=${dMedian}t  stdev=${dStdev.toFixed(2)}t  CV=${dCv.toFixed(2)}`);
    console.log(`    min=${dMin}t  p5=${dP5}t  p95=${dP95}t  p99=${dP99}t  max=${dMax}t`);

    // ── Distraction event frequency ──
    const distractedDelays = result.delayLog.filter(d => d.distracted);
    console.log(`\n  DISTRACTION EVENTS: ${distractedDelays.length} (${(distractedDelays.length / result.delayLog.length * 100).toFixed(3)}% of delays)`);
    if (distractedDelays.length > 0) {
      const distractValues = distractedDelays.map(d => d.result);
      const dMin2 = Math.min(...distractValues);
      const dMax2 = Math.max(...distractValues);
      const dMean2 = distractValues.reduce((a, b) => a + b, 0) / distractValues.length;
      console.log(`    distraction delays: min=${dMin2}t  max=${dMax2}t  mean=${dMean2.toFixed(1)}t`);
    }

    // ── Cap hit frequency (how often delays hit the max) ──
    console.log('\n  CAP HIT FREQUENCY:');
    const capGroups = {};
    for (const d of result.delayLog) {
      if (d.max > 0) {
        const key = `max=${d.max}`;
        if (!capGroups[key]) capGroups[key] = { total: 0, hits: 0 };
        capGroups[key].total++;
        if (d.result >= d.max && !d.distracted) capGroups[key].hits++;
      }
    }
    for (const [key, g] of Object.entries(capGroups).sort()) {
      const pct = (g.hits / g.total * 100).toFixed(1);
      const flag = parseFloat(pct) > 30 ? '⚠ HIGH CAP HIT' : '✓ OK';
      console.log(`    ${key}: ${g.hits}/${g.total} (${pct}%)  ${flag}`);
    }

    // ── Click interval analysis ──
    console.log('\n  CLICK INTERVAL DISTRIBUTION (ms):');
    const intervals = [];
    for (let i = 1; i < result.clickLog.length; i++) {
      const prev = result.clickLog[i - 1];
      const curr = result.clickLog[i];
      const tickDiff = curr.tick - prev.tick;
      const msDiff = tickDiff * 600 + curr.ms - prev.ms;
      intervals.push({ ms: msDiff, action: curr.action });
    }

    // Overall histogram (200ms bins, top 20)
    const bins = {};
    for (const iv of intervals) {
      const bin = Math.floor(iv.ms / 200) * 200;
      bins[bin] = (bins[bin] || 0) + 1;
    }
    const sortedBins = Object.keys(bins).map(Number).sort((a, b) => a - b);
    const maxCount = Math.max(...Object.values(bins));
    console.log('  Overall (200ms bins, top 20):');
    let shown = 0;
    for (const bin of sortedBins) {
      if (shown >= 20) break;
      const pct = (bins[bin] / intervals.length * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(bins[bin] / maxCount * 40));
      console.log(`    ${String(bin).padStart(6)}-${String(bin + 200).padStart(6)}ms: ${String(bins[bin]).padStart(5)} (${pct.padStart(5)}%) ${bar}`);
      shown++;
    }

    // ── Per-action-type interval analysis ──
    const actionTypes = {};
    for (const cl of result.clickLog) {
      if (!actionTypes[cl.action]) actionTypes[cl.action] = [];
      actionTypes[cl.action].push(cl);
    }

    console.log('\n  PER-ACTION INTERVAL ANALYSIS (top 10 by count):');
    const sortedActions = Object.entries(actionTypes).sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    for (const [action, clicks] of sortedActions) {
      if (clicks.length < 10) continue;
      const actionIntervals = [];
      for (let i = 1; i < clicks.length; i++) {
        const td = clicks[i].tick - clicks[i - 1].tick;
        actionIntervals.push(td * 600 + clicks[i].ms - clicks[i - 1].ms);
      }
      const mean = actionIntervals.reduce((a, b) => a + b, 0) / actionIntervals.length;
      const sorted = [...actionIntervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const p5 = sorted[Math.floor(sorted.length * 0.05)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const variance = actionIntervals.reduce((s, v) => s + (v - mean) ** 2, 0) / actionIntervals.length;
      const stdev = Math.sqrt(variance);
      const cv = stdev / mean;

      // Check for single-bin concentration
      const actionBins = {};
      for (const v of actionIntervals) {
        const b = Math.floor(v / 200) * 200;
        actionBins[b] = (actionBins[b] || 0) + 1;
      }
      const maxBinPct = Math.max(...Object.values(actionBins)) / actionIntervals.length * 100;
      const maxBinVal = Number(Object.entries(actionBins).find(([_, c]) => c === Math.max(...Object.values(actionBins)))[0]);

      const flag = maxBinPct > 30 ? '⚠ DETECTABLE' : maxBinPct > 15 ? '⚠ SUSPICIOUS' : '✓ OK';
      console.log(`    ${action.padEnd(25)} n=${String(clicks.length).padStart(5)}  mean=${String(Math.round(mean)).padStart(6)}ms  med=${String(median).padStart(6)}ms  stdev=${String(Math.round(stdev)).padStart(6)}ms  CV=${cv.toFixed(2).padStart(5)}  maxBin=${maxBinPct.toFixed(1)}% @ ${maxBinVal}ms  ${flag}`);
    }

    // ── Autocorrelation ──
    console.log('\n  AUTOCORRELATION OF CLICK INTERVALS (lag 1-5):');
    for (let lag = 1; lag <= 5; lag++) {
      let sumAB = 0, sumA = 0, sumB = 0, sumA2 = 0, sumB2 = 0;
      const n = intervals.length - lag;
      if (n <= 0) continue;
      for (let i = 0; i < n; i++) {
        const a = intervals[i].ms;
        const b = intervals[i + lag].ms;
        sumA += a; sumB += b; sumAB += a * b;
        sumA2 += a * a; sumB2 += b * b;
      }
      const meanA = sumA / n, meanB = sumB / n;
      const cov = sumAB / n - meanA * meanB;
      const varA = sumA2 / n - meanA * meanA;
      const varB = sumB2 / n - meanB * meanB;
      const ac = cov / Math.sqrt(Math.max(0.0001, varA * varB));
      const flag = Math.abs(ac) > 0.5 ? '⚠ HIGH' : Math.abs(ac) > 0.3 ? '⚠ MODERATE' : '✓ OK';
      console.log(`    lag ${lag}: ${ac.toFixed(3).padStart(7)}  ${flag}`);
    }

    // ── Action sequence n-gram analysis ──
    console.log('\n  ACTION SEQUENCE 3-GRAM ANALYSIS (top 10):');
    const actionSeq = result.clickLog.map(c => c.action);
    const ngrams = {};
    for (let i = 0; i < actionSeq.length - 2; i++) {
      const ng = `${actionSeq[i]}→${actionSeq[i + 1]}→${actionSeq[i + 2]}`;
      ngrams[ng] = (ngrams[ng] || 0) + 1;
    }
    const sortedNgrams = Object.entries(ngrams).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const totalNgrams = Object.values(ngrams).reduce((a, b) => a + b, 0);
    for (const [ng, count] of sortedNgrams) {
      const pct = (count / totalNgrams * 100).toFixed(1);
      const flag = parseFloat(pct) > 50 ? '⚠ DOMINANT' : parseFloat(pct) > 30 ? '⚠ HIGH' : '✓ OK';
      console.log(`    ${ng.padEnd(55)} ${String(count).padStart(5)} (${pct.padStart(5)}%)  ${flag}`);
    }

    // ── Session/break pattern analysis ──
    console.log('\n  SESSION/BREAK PATTERN:');
    if (result.breakLog.length > 0) {
      const nightlyBreaks = result.breakLog.filter(b => b.type === 'nightly');
      const shortBreaks = result.breakLog.filter(b => b.type === 'short');

      console.log(`    Total breaks: ${result.breakLog.length}  (nightly: ${nightlyBreaks.length}, short: ${shortBreaks.length})`);

      if (shortBreaks.length > 0) {
        const shortDurations = shortBreaks.map(b => b.durationMs / MS_PER_MINUTE);
        const sMean = shortDurations.reduce((a, b) => a + b, 0) / shortDurations.length;
        const sSorted = [...shortDurations].sort((a, b) => a - b);
        const sMedian = sSorted[Math.floor(sSorted.length / 2)];
        const sMin = sSorted[0];
        const sMax = sSorted[sSorted.length - 1];
        const sVar = shortDurations.reduce((s, v) => s + (v - sMean) ** 2, 0) / shortDurations.length;
        const sCv = Math.sqrt(sVar) / sMean;
        console.log(`    Short breaks: n=${shortBreaks.length}  mean=${sMean.toFixed(1)}min  median=${sMedian.toFixed(1)}min  min=${sMin.toFixed(1)}min  max=${sMax.toFixed(1)}min  CV=${sCv.toFixed(2)}  ${sCv < 0.2 ? '⚠ TOO REGULAR' : '✓ OK'}`);
      }

      if (nightlyBreaks.length > 0) {
        const nightlyDurations = nightlyBreaks.map(b => b.durationMs / MS_PER_MINUTE);
        const nMean = nightlyDurations.reduce((a, b) => a + b, 0) / nightlyDurations.length;
        const nSorted = [...nightlyDurations].sort((a, b) => a - b);
        const nMedian = nSorted[Math.floor(nSorted.length / 2)];
        console.log(`    Nightly sleeps: n=${nightlyBreaks.length}  mean=${nMean.toFixed(1)}min  median=${nMedian.toFixed(1)}min  min=${nSorted[0].toFixed(1)}min  max=${nSorted[nSorted.length - 1].toFixed(1)}min`);
      }

      // Break interval analysis
      if (result.breakLog.length > 2) {
        const breakIntervals = [];
        for (let i = 1; i < result.breakLog.length; i++) {
          breakIntervals.push((result.breakLog[i].startTick - result.breakLog[i - 1].startTick) / TICKS_PER_MINUTE);
        }
        const biMean = breakIntervals.reduce((a, b) => a + b, 0) / breakIntervals.length;
        const biSorted = [...breakIntervals].sort((a, b) => a - b);
        const biMedian = biSorted[Math.floor(biSorted.length / 2)];
        const biVar = breakIntervals.reduce((s, v) => s + (v - biMean) ** 2, 0) / breakIntervals.length;
        const biCv = Math.sqrt(biVar) / biMean;
        console.log(`    Break intervals: mean=${biMean.toFixed(1)}min  median=${biMedian.toFixed(1)}min  CV=${biCv.toFixed(2)}  ${biCv < 0.2 ? '⚠ TOO REGULAR' : '✓ OK'}`);
      }
    }

    // ── Pre-logout idle delay analysis ──
    console.log('\n  PRE-LOGOUT IDLE DELAY ANALYSIS:');
    // The pre-logout delay is the time between going idle and the break starting.
    // We can infer it from the break log: the gap between the last action tick
    // and the break start tick.
    // Since we don't track last-action-tick per break in the sim, we check
    // the shortBreakDelayTicks distribution indirectly via the idle delays.
    // For now, report the IDLE_DELAY distribution:
    const idleDelays = result.delayLog.filter(d => d.trigger === 100 && d.max === 20);
    if (idleDelays.length > 0) {
      const idleValues = idleDelays.map(d => d.result);
      const iMean = idleValues.reduce((a, b) => a + b, 0) / idleValues.length;
      const iSorted = [...idleValues].sort((a, b) => a - b);
      const iMedian = iSorted[Math.floor(iSorted.length / 2)];
      const iMin = iSorted[0];
      const iMax = iSorted[iSorted.length - 1];
      console.log(`    Idle delays (max=20): n=${idleDelays.length}  mean=${iMean.toFixed(1)}t  median=${iMedian}t  min=${iMin}t  max=${iMax}t`);
    }
  }

  // ── Cross-account comparison ──
  if (results.length > 1) {
    console.log('\n\n  CROSS-ACCOUNT COMPARISON:');
    console.log('  ' + '─'.repeat(78));
    for (const r of results) {
      const intervals = [];
      for (let i = 1; i < r.clickLog.length; i++) {
        const td = r.clickLog[i].tick - r.clickLog[i - 1].tick;
        intervals.push(td * 600 + r.clickLog[i].ms - r.clickLog[i - 1].ms);
      }
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
      const cv = Math.sqrt(variance) / mean;
      const delayValues = r.delayLog.map(d => d.result);
      const dMean = delayValues.reduce((a, b) => a + b, 0) / delayValues.length;
      const dMax = Math.max(...delayValues);
      console.log(`    ${r.accountName.padEnd(15)} clicks=${String(r.clickLog.length).padStart(6)}  delayMean=${dMean.toFixed(2)}t  delayMax=${dMax}t  clickMean=${String(Math.round(mean)).padStart(6)}ms  clickCV=${cv.toFixed(2).padStart(5)}  distract=${r.distractions}`);
    }
  }

  // ── Summary of detectable patterns ──
  console.log('\n\n  DETECTABLE PATTERN SUMMARY:');
  console.log('  ' + '═'.repeat(78));
  let totalWarnings = 0;
  for (const result of results) {
    const warnings = [];

    // Check 1: Delay distribution — no hard ceiling pattern
    const delayValues = result.delayLog.map(d => d.result);
    const delayBins = {};
    for (const v of delayValues) {
      const bin = v <= 5 ? String(v) : '6+';
      delayBins[bin] = (delayBins[bin] || 0) + 1;
    }
    const maxDelayBinPct = Math.max(...Object.values(delayBins)) / delayValues.length * 100;
    if (maxDelayBinPct > 50) {
      const dominantBin = Object.entries(delayBins).sort((a, b) => b[1] - a[1])[0][0];
      warnings.push(`Delay distribution: ${maxDelayBinPct.toFixed(1)}% at ${dominantBin}t (threshold: 50% — too concentrated)`);
    }

    // Check 2: No delays above max (distraction should break the ceiling)
    const aboveMax = result.delayLog.filter(d => d.max > 0 && d.result > d.max && !d.distracted);
    if (aboveMax.length > 0) {
      warnings.push(`${aboveMax.length} delays exceeded their max cap without distraction (should be 0)`);
    }

    // Check 3: Distraction events actually fire
    if (result.distractions === 0) {
      warnings.push('No distraction events fired in 7 days (expected ~1 per hour of active play)');
    }

    // Check 4: Click interval concentration
    const intervals = [];
    for (let i = 1; i < result.clickLog.length; i++) {
      const td = result.clickLog[i].tick - result.clickLog[i - 1].tick;
      intervals.push(td * 600 + result.clickLog[i].ms - result.clickLog[i - 1].ms);
    }
    const bins = {};
    for (const v of intervals) {
      const b = Math.floor(v / 200) * 200;
      bins[b] = (bins[b] || 0) + 1;
    }
    const maxBinPct = Math.max(...Object.values(bins)) / intervals.length * 100;
    if (maxBinPct > 30) {
      warnings.push(`Overall click intervals: ${maxBinPct.toFixed(1)}% in one 200ms bin (threshold: 30%)`);
    }

    // Check 5: CV too low
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv < 0.3) {
      warnings.push(`Overall CV=${cv.toFixed(2)} (threshold: 0.3 — too regular)`);
    }

    // Check 6: Autocorrelation
    for (let lag = 1; lag <= 3; lag++) {
      let sumAB = 0, sumA = 0, sumB = 0, sumA2 = 0, sumB2 = 0;
      const n = intervals.length - lag;
      if (n <= 0) continue;
      for (let i = 0; i < n; i++) {
        const a = intervals[i], b = intervals[i + lag];
        sumA += a; sumB += b; sumAB += a * b; sumA2 += a * a; sumB2 += b * b;
      }
      const meanA = sumA / n, meanB = sumB / n;
      const ac = (sumAB / n - meanA * meanB) / Math.sqrt(Math.max(0.0001, (sumA2 / n - meanA * meanA) * (sumB2 / n - meanB * meanB)));
      if (Math.abs(ac) > 0.5) {
        warnings.push(`Autocorrelation at lag ${lag}: ${ac.toFixed(2)} (threshold: 0.5)`);
      }
    }

    // Check 7: Action sequence repetition
    const actionSeq = result.clickLog.map(c => c.action);
    const ngrams = {};
    for (let i = 0; i < actionSeq.length - 2; i++) {
      const ng = `${actionSeq[i]}→${actionSeq[i + 1]}→${actionSeq[i + 2]}`;
      ngrams[ng] = (ngrams[ng] || 0) + 1;
    }
    const maxNgramPct = Math.max(...Object.values(ngrams)) / Object.values(ngrams).reduce((a, b) => a + b, 0) * 100;
    if (maxNgramPct > 50) {
      const dominantNgram = Object.entries(ngrams).sort((a, b) => b[1] - a[1])[0][0];
      warnings.push(`Action 3-gram "${dominantNgram}" accounts for ${maxNgramPct.toFixed(1)}% (threshold: 50%)`);
    }

    // Check 8: Break regularity
    if (result.breakLog.length > 3) {
      const shortBreaks = result.breakLog.filter(b => b.type === 'short');
      if (shortBreaks.length > 3) {
        const shortDurations = shortBreaks.map(b => b.durationMs / MS_PER_MINUTE);
        const sMean = shortDurations.reduce((a, b) => a + b, 0) / shortDurations.length;
        const sVar = shortDurations.reduce((s, v) => s + (v - sMean) ** 2, 0) / shortDurations.length;
        const sCv = Math.sqrt(sVar) / sMean;
        if (sCv < 0.2) {
          warnings.push(`Short break CV=${sCv.toFixed(2)} (threshold: 0.2 — too regular)`);
        }
      }
    }

    if (warnings.length === 0) {
      console.log(`  ✓ ${result.accountName}: No detectable patterns found`);
    } else {
      totalWarnings += warnings.length;
      console.log(`  ⚠ ${result.accountName}: ${warnings.length} warning(s):`);
      for (const w of warnings) {
        console.log(`      - ${w}`);
      }
    }
  }
  console.log(`\n  Total warnings across all accounts: ${totalWarnings}`);
  console.log('  ' + '═'.repeat(78) + '\n');
}

// ─── Main ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let days = 7, accounts = 3, baseSeed = 12345;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) days = parseInt(args[i + 1]);
  if (args[i] === '--accounts' && args[i + 1]) accounts = parseInt(args[i + 1]);
  if (args[i] === '--seed' && args[i + 1]) baseSeed = parseInt(args[i + 1]);
}

const totalTicks = days * 24 * 60 * TICKS_PER_MINUTE;
console.log(`Simulating ${accounts} account(s) over ${days} days (${totalTicks.toLocaleString()} ticks each)...`);

const t0 = Date.now();
const results = [];
const accountNames = ['Cyber4Gras', 'MercherAlt1', 'MercherAlt2', 'MercherAlt3', 'MercherAlt4'];
for (let i = 0; i < accounts; i++) {
  const name = i < accountNames.length ? accountNames[i] : `account_${i + 1}`;
  const seed = baseSeed + i * 7777;
  console.log(`  Running ${name} (seed=${seed})...`);
  const result = simulateAccount(name, seed, totalTicks);
  results.push(result);
}
const elapsed = Date.now() - t0;
console.log(`Simulation completed in ${(elapsed / 1000).toFixed(1)}s`);

analyzeResults(results);
