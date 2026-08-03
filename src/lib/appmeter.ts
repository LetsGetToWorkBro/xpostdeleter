/**
 * App-wide delete throughput accounting.
 *
 * This exists to answer one specific question that public documentation does
 * not: **is there a per-app cap on deletes, on top of the per-user one?**
 *
 * Post *creation* has a documented app-level ceiling (10,000/24h) alongside its
 * per-user limit. If deletes have an equivalent, a shared "managed" app stops
 * being a convenience and becomes a bottleneck shared by every customer at
 * once — roughly two heavy users a day, total. That would make managed mode
 * unsellable, and there is no way to find out except to measure it.
 *
 * The signal we're looking for: a 429 arriving while the *user's own* 15-minute
 * window still had budget left. Per-user limits cannot produce that. DeletionJob
 * flags those as `appThrottleEvents`; this module aggregates them across jobs
 * along with total daily throughput.
 *
 * Written one shard per job per day rather than to a single counter, so there
 * is no contention and no lost-update race — KV read-modify-write from many
 * Durable Objects at once would silently undercount, which is exactly the wrong
 * failure mode for a measurement.
 */

const PREFIX = 'appmeter';
const TTL_SECONDS = 60 * 60 * 24 * 45;

export interface MeterShard {
  date: string;
  jobId: string;
  kind: string;
  /** Real DELETE requests issued by this job on this day. */
  deletes: number;
  /** 429s received while this job's own per-user window still had room. */
  earlyThrottles: number;
  managed: boolean;
  updatedAt: number;
}

export function utcDate(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

const shardKey = (date: string, jobId: string) => `${PREFIX}:${date}:${jobId}`;

/**
 * Record this job's running totals for today. Called once per tick, not once
 * per delete — a tick is at most 50 deletes, so this is cheap.
 */
export async function recordShard(
  kv: KVNamespace,
  shard: Omit<MeterShard, 'date' | 'updatedAt'> & { date?: string },
): Promise<void> {
  const date = shard.date ?? utcDate();
  try {
    await kv.put(
      shardKey(date, shard.jobId),
      JSON.stringify({ ...shard, date, updatedAt: Date.now() } satisfies MeterShard),
      { expirationTtl: TTL_SECONDS },
    );
  } catch (err) {
    // Observability must never break the job it is observing.
    console.warn('appmeter write failed', err instanceof Error ? err.message : err);
  }
}

export interface MeterDay {
  date: string;
  deletes: number;
  earlyThrottles: number;
  jobs: number;
  managedJobs: number;
  /** True if any job saw a 429 with per-user budget to spare. */
  appCapSuspected: boolean;
}

export async function readDays(kv: KVNamespace, days = 14): Promise<MeterDay[]> {
  const wanted: string[] = [];
  for (let i = 0; i < days; i++) wanted.push(utcDate(Date.now() - i * 86_400_000));

  const out: MeterDay[] = [];
  for (const date of wanted) {
    const listed = await kv.list({ prefix: `${PREFIX}:${date}:`, limit: 1000 });
    if (!listed.keys.length) continue;

    const shards = await Promise.all(
      listed.keys.map(async (k) => (await kv.get(k.name, 'json')) as MeterShard | null),
    );
    const live = shards.filter((s): s is MeterShard => Boolean(s));

    const day: MeterDay = {
      date,
      deletes: live.reduce((a, s) => a + (s.deletes || 0), 0),
      earlyThrottles: live.reduce((a, s) => a + (s.earlyThrottles || 0), 0),
      jobs: live.length,
      managedJobs: live.filter((s) => s.managed).length,
      appCapSuspected: live.some((s) => (s.earlyThrottles || 0) > 0),
    };
    out.push(day);
  }
  return out;
}

/**
 * Turn the raw days into the verdict the operator actually wants: does an
 * app-level delete cap exist, and if so roughly where does it bite?
 */
export function interpret(days: MeterDay[]): {
  verdict: 'no_evidence' | 'app_cap_suspected' | 'insufficient_data';
  peakDailyDeletes: number;
  totalEarlyThrottles: number;
  note: string;
} {
  const peakDailyDeletes = days.reduce((a, d) => Math.max(a, d.deletes), 0);
  const totalEarlyThrottles = days.reduce((a, d) => a + d.earlyThrottles, 0);

  if (totalEarlyThrottles > 0) {
    const worst = days.find((d) => d.earlyThrottles > 0);
    return {
      verdict: 'app_cap_suspected',
      peakDailyDeletes,
      totalEarlyThrottles,
      note: `Saw ${totalEarlyThrottles} throttle(s) while the user's own window still had budget — first on ${worst?.date}, a day with ${worst?.deletes} app-wide deletes. That is the signature of an app-level cap; treat ~${worst?.deletes} as the working ceiling and do not scale managed mode past it until you have talked to X.`,
    };
  }
  if (peakDailyDeletes < 10_000) {
    return {
      verdict: 'insufficient_data',
      peakDailyDeletes,
      totalEarlyThrottles: 0,
      note: `No early throttles, but peak app-wide throughput has only reached ${peakDailyDeletes} deletes/day. Post creation caps at 10,000/day per app, so you have not yet pushed hard enough to rule out an equivalent delete cap. Inconclusive until a day clears ~10,000.`,
    };
  }
  return {
    verdict: 'no_evidence',
    peakDailyDeletes,
    totalEarlyThrottles: 0,
    note: `Cleared ${peakDailyDeletes} deletes in a day across the app with no early throttling. No evidence of an app-level delete cap at this volume.`,
  };
}
