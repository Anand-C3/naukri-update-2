/**
 * run-cloud-schedule.js
 * Automated Cloud Session Runner for GitHub Actions (Account 2)
 * Runs alternating 45-minute profile updates during Indian business hours (Mon-Fri).
 * Maintains an unbroken 24/7 self-dispatch relay with strict < 3h job lifespans
 * to prevent GitHub Actions timeouts (zero cron delay, zero laptop dependence).
 */

const { spawnSync } = require("child_process");

const SLOTS = (process.env.SCHEDULE_SLOTS || "08:50,09:35,10:20,11:05,11:50,12:35,13:20,14:05,14:50,15:35,16:20,17:05,17:50,18:35")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const MAX_CYCLES_PER_JOB = 4; // Max 4 daytime cycles (~3 hours runtime, well below 350-min timeout)
const MAX_RELAY_SLEEP_MS = 2.5 * 60 * 60 * 1000; // 2.5 hours max sleep in overnight relay before handoff

function log(msg) {
  const istTime = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  console.log(`[${istTime} IST] ${msg}`);
}

function getISTNow() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
    hour12: false
  });
  const parts = formatter.formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour: parseInt(map.hour, 10),
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10),
    dayOfWeek: d.getDay() // 0 = Sun, 6 = Sat
  };
}

function parseTimeToMinutes(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function runSingleRefresh() {
  log("Executing profile headline refresh...");
  const child = spawnSync("node", ["naukri-profile-refresh.js"], {
    stdio: "inherit",
    env: { ...process.env, REFRESH_CYCLES: "1", SKIP_CV_UPLOAD: "true" }
  });
  if (child.status !== 0) {
    log(`Warning: refresh exited with status ${child.status}`);
  } else {
    log("Refresh completed successfully.");
  }
  return child.status === 0;
}

function dispatchNextSession() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo) {
    log(`Dispatching next session to GitHub Actions for repo ${repo}...`);
    const res = spawnSync("gh", ["workflow", "run", "naukri-refresh.yml", "--repo", repo], {
      stdio: "inherit",
      env: process.env
    });
    if (res.status === 0) {
      log("Next session dispatched successfully via workflow_dispatch.");
    } else {
      log(`Warning: gh workflow run exited with status ${res.status}`);
    }
  } else {
    log("Note: GITHUB_REPOSITORY not set (local run). Skipping workflow dispatch.");
  }
}

function checkOtherActiveRuns() {
  const repo = process.env.GITHUB_REPOSITORY;
  const currentRunId = process.env.GITHUB_RUN_ID;
  if (!repo || !currentRunId) return false;
  try {
    const res = spawnSync("gh", [
      "run", "list",
      "--repo", repo,
      "--workflow", "naukri-refresh.yml",
      "--status", "in_progress",
      "--json", "databaseId"
    ], { env: process.env, encoding: "utf8" });
    if (res.status === 0 && res.stdout) {
      const runs = JSON.parse(res.stdout);
      const otherRuns = runs.filter(r => String(r.databaseId) !== String(currentRunId));
      if (otherRuns.length > 0) {
        log(`Another run (#${otherRuns[0].databaseId}) is already in progress. Exiting this duplicate instance cleanly.`);
        return true;
      }
    }
  } catch (e) {
    // If check fails, ignore and proceed
  }
  return false;
}

function getNextBusinessSlotTarget(slots) {
  const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const [firstH, firstM] = slots[0].split(":").map(Number);
  const dayOfWeek = istNow.getDay(); // 0 = Sun, 6 = Sat
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  if (isWeekday) {
    const currentMins = istNow.getHours() * 60 + istNow.getMinutes();
    for (const slot of slots) {
      const [h, m] = slot.split(":").map(Number);
      const slotMins = h * 60 + m;
      if (slotMins > currentMins) {
        const target = new Date(istNow);
        target.setHours(h, m, 0, 0);
        return target;
      }
    }
  }

  // All slots today have passed or weekend -> find next business day
  const target = new Date(istNow);
  let daysToAdd = 1;
  if (dayOfWeek === 5) {
    daysToAdd = 3; // Friday -> Monday
  } else if (dayOfWeek === 6) {
    daysToAdd = 2; // Saturday -> Monday
  }
  target.setDate(target.getDate() + daysToAdd);
  target.setHours(firstH, firstM, 0, 0);
  return target;
}

async function relayUntilNextBusinessSlot(slots) {
  const target = getNextBusinessSlotTarget(slots);
  const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const diffMs = target.getTime() - istNow.getTime();

  if (diffMs <= 0) {
    log("Target slot time reached. Dispatching fresh daytime runner session...");
    dispatchNextSession();
    process.exit(0);
  }

  const diffHours = (diffMs / (1000 * 60 * 60)).toFixed(2);
  log(`Next business slot target: ${target.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })} IST (in ${diffHours} hours).`);

  if (diffMs > MAX_RELAY_SLEEP_MS) {
    log(`Sleeping for 2.5 hours in cloud relay mode, then handing off to next runner...`);
    await new Promise(res => setTimeout(res, MAX_RELAY_SLEEP_MS));
    dispatchNextSession();
    process.exit(0);
  } else {
    log(`Sleeping remaining ${(diffMs / (1000 * 60)).toFixed(1)} minutes until target slot at ${target.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })} IST...`);
    await new Promise(res => setTimeout(res, diffMs));
    log("Morning wakeup reached! Dispatching fresh daytime runner session...");
    dispatchNextSession();
    process.exit(0);
  }
}

async function main() {
  // Prevent duplicate runs from overlapping
  if (checkOtherActiveRuns()) {
    process.exit(0);
  }

  // Single run mode check
  if (process.env.SINGLE_RUN === "true" || process.argv.includes("--once")) {
    log("Single-run mode requested.");
    runSingleRefresh();
    process.exit(0);
  }

  const now = getISTNow();
  const isWeekend = now.dayOfWeek === 0 || now.dayOfWeek === 6;
  const currentMinutes = now.hour * 60 + now.minute;

  const firstSlotMins = parseTimeToMinutes(SLOTS[0]);
  const lastSlotMins = parseTimeToMinutes(SLOTS[SLOTS.length - 1]);
  const isPastLastSlot = currentMinutes > lastSlotMins;

  // Filter remaining slots for today
  // - On weekends or after the final slot of the day: 0 slots remaining (enter relay)
  // - On weekday morning at startup: allow a 5-min grace window for boot-up delay
  // - During the day: only slots scheduled in the future (or current minute)
  let remainingSlots = [];
  if (!isWeekend && !isPastLastSlot) {
    remainingSlots = SLOTS.filter(slot => {
      const slotMins = parseTimeToMinutes(slot);
      if (slotMins === firstSlotMins && currentMinutes <= firstSlotMins + 5) {
        return true;
      }
      return slotMins >= currentMinutes;
    });
  }

  if (remainingSlots.length === 0) {
    log(isWeekend 
      ? "Weekend detected. Entering cloud relay to sleep until Monday business hours."
      : "All scheduled slots for today have passed. Entering overnight cloud relay.");
    await relayUntilNextBusinessSlot(SLOTS);
    return;
  }

  log(`Current time: ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")} (${currentMinutes} mins from midnight).`);
  log(`Remaining slots today: ${remainingSlots.join(", ")}`);

  let cyclesRun = 0;
  for (let i = 0; i < remainingSlots.length; i++) {
    const slot = remainingSlots[i];
    const slotMins = parseTimeToMinutes(slot);
    const nowCurrent = getISTNow();
    const nowMins = nowCurrent.hour * 60 + nowCurrent.minute;
    const diffMins = slotMins - nowMins;

    if (diffMins > 0) {
      log(`Next slot [${slot}] is in ${diffMins} minutes. Sleeping until ${slot} IST...`);
      const delayMs = (diffMins * 60 - nowCurrent.second) * 1000;
      if (delayMs > 0) {
        await new Promise(res => setTimeout(res, delayMs));
      }
    }

    log(`>>> Starting Slot [${slot}] update...`);
    runSingleRefresh();
    cyclesRun++;

    // Check if this job should hand off to the next session during business hours
    const hasMoreSlots = (i + 1) < remainingSlots.length;
    if (cyclesRun >= MAX_CYCLES_PER_JOB && hasMoreSlots) {
      log(`Reached max ${MAX_CYCLES_PER_JOB} daytime cycles for this runner session. Handing off to fresh runner...`);
      dispatchNextSession();
      process.exit(0);
    }
  }

  log("All scheduled updates for today have completed successfully!");
  log("Handing off to fresh overnight relay runner...");
  dispatchNextSession();
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error in session runner:", err);
  process.exit(1);
});
