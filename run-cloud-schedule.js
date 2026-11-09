/**
 * run-cloud-schedule.js
 * Automated Cloud Session Runner for GitHub Actions
 * Runs alternating 45-minute profile updates during Indian business hours (Mon-Fri).
 */

const { spawnSync } = require("child_process");

const SLOTS = (process.env.SCHEDULE_SLOTS || "09:15,10:45,12:15,13:45,15:15,16:45,18:15")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const MAX_CYCLES_PER_JOB = 4; // Max 4 cycles per job (4 * 90 min = 6 hours max limit)

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

async function main() {
  const now = getISTNow();

  // 1. Weekend check
  if (now.dayOfWeek === 0 || now.dayOfWeek === 6) {
    log("Weekend detected. Skipping run until Monday.");
    process.exit(0);
  }

  // 2. Single run mode check
  if (process.env.SINGLE_RUN === "true" || process.argv.includes("--once")) {
    log("Single-run mode requested.");
    runSingleRefresh();
    process.exit(0);
  }

  const currentMinutes = now.hour * 60 + now.minute;
  log(`Current time: ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")} (${currentMinutes} mins from midnight).`);

  // Find remaining slots for today
  // Include slot if current time is before slot, or within 15 mins after slot start
  const remainingSlots = SLOTS.filter(slot => {
    const slotMins = parseTimeToMinutes(slot);
    return slotMins >= currentMinutes - 15;
  });

  if (remainingSlots.length === 0) {
    log("All scheduled slots for today have passed. Exiting cleanly.");
    process.exit(0);
  }

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
      // Sleep until slot with precision
      const delayMs = (diffMins * 60 - nowCurrent.second) * 1000;
      if (delayMs > 0) {
        await new Promise(res => setTimeout(res, delayMs));
      }
    }

    log(`>>> Starting Slot [${slot}] update...`);
    runSingleRefresh();
    cyclesRun++;

    // Check if this job should hand off to the next session
    const hasMoreSlots = (i + 1) < remainingSlots.length;
    if (cyclesRun >= MAX_CYCLES_PER_JOB && hasMoreSlots) {
      log(`Reached max ${MAX_CYCLES_PER_JOB} cycles for this runner session. Dispatching next session to GitHub Actions...`);
      const repo = process.env.GITHUB_REPOSITORY;
      if (repo) {
        spawnSync("gh", ["workflow", "run", "naukri-refresh.yml", "--repo", repo], {
          stdio: "inherit",
          env: process.env
        });
      }
      log("Next session dispatched. Exiting current runner.");
      process.exit(0);
    }
  }

  log("All scheduled updates for today have completed successfully!");
}

main().catch(err => {
  console.error("Fatal error in session runner:", err);
  process.exit(1);
});
