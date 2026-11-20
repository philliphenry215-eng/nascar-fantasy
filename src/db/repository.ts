import crypto from 'node:crypto';
import { eq, and, ne, isNull } from 'drizzle-orm';
import { db } from './index.ts';
import {
  users,
  leagueSettings,
  seriesConfig,
  drivers,
  races,
  seasonRosters,
  weeklyPicks,
  raceDriverResults,
} from './schema.ts';
import {
  processRaceResultsWithOwnerFallback,
  NascarFeedResult,
  NascarStageFeed,
  ComputedRaceResult,
} from '../lib/nascar-scoring-engine.ts';
import { hashPassword, verifyPassword } from '../lib/session.ts';

let syncInProgressPromise: Promise<Record<1 | 2 | 3, ComputedRaceResult[]>> | null =
  null;
let referenceSeeded = false;
let seedPromise: Promise<void> | null = null;

/**
 * Strips sensitive fields like `passwordHash` before returning user rows to callers.
 */
export function sanitizeUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    uid: u.uid,
    email: u.email,
    name: u.name,
    avatar: u.avatar,
    lastYearRank: u.lastYearRank,
    role: u.role,
    cumulativePriorPoints: u.cumulativePriorPoints,
    createdAt: u.createdAt,
  };
}

/**
 * Idempotently seeds canonical league config, NASCAR series, drivers, and races (never fake users or picks).
 */
export async function ensureReferenceDataSeeded(): Promise<void> {
  if (referenceSeeded) return;
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    try {
      await db
        .insert(leagueSettings)
        .values({
          id: 'default',
          leagueName: 'Pit Box Fantasy League',
          inviteCode: 'PITBOX-2026',
        })
        .onConflictDoNothing();

      await db
        .insert(seriesConfig)
        .values([
          {
            id: 1,
            name: 'NASCAR Cup Series',
            shortName: 'Cup',
            badgeColor: '#FFD100',
            maxWeeklyUsesPerDriver: 5,
            chaseActive: true,
            firstPlacePoints: 55,
            useCarAnchorFallback: true,
          },
          {
            id: 2,
            name: "NASCAR O'Reilly's Series",
            shortName: "O'Reilly's",
            badgeColor: '#E4002B',
            maxWeeklyUsesPerDriver: 5,
            chaseActive: true,
            firstPlacePoints: 55,
            useCarAnchorFallback: true,
          },
          {
            id: 3,
            name: 'NASCAR Craftsman Truck Series',
            shortName: 'Trucks',
            badgeColor: '#1D63FF',
            maxWeeklyUsesPerDriver: 5,
            chaseActive: true,
            firstPlacePoints: 55,
            useCarAnchorFallback: true,
          },
        ])
        .onConflictDoNothing();

      const canonicalDrivers: Array<typeof drivers.$inferInsert> = [
        // Cup Series - Chase (Prev Playoff Drivers)
        { id: 'c1', nascarDriverId: 4001, seriesId: 1, carNumber: '5', fullName: 'Kyle Larson', team: 'Hendrick Motorsports', madeLastYearChase: true, inCurrentChase: true, isBuschwhacker: false, active: true },
        { id: 'c2', nascarDriverId: 4002, seriesId: 1, carNumber: '24', fullName: 'William Byron', team: 'Hendrick Motorsports', madeLastYearChase: true, inCurrentChase: true, isBuschwhacker: false, active: true },
        { id: 'c3', nascarDriverId: 4003, seriesId: 1, carNumber: '12', fullName: 'Ryan Blaney', team: 'Team Penske', madeLastYearChase: true, inCurrentChase: true, isBuschwhacker: false, active: true },
        { id: 'c4', nascarDriverId: 4004, seriesId: 1, carNumber: '20', fullName: 'Christopher Bell', team: 'Joe Gibbs Racing', madeLastYearChase: true, inCurrentChase: true, isBuschwhacker: false, active: true },
        { id: 'c5', nascarDriverId: 4005, seriesId: 1, carNumber: '11', fullName: 'Denny Hamlin', team: 'Joe Gibbs Racing', madeLastYearChase: true, inCurrentChase: true, isBuschwhacker: false, active: true },
        { id: 'c6', nascarDriverId: 4006, seriesId: 1, carNumber: '9', fullName: 'Chase Elliott', team: 'Hendrick Motorsports', madeLastYearChase: true, inCurrentChase: true, isBuschwhacker: false, active: true },
        { id: 'c7', nascarDriverId: 4007, seriesId: 1, carNumber: '45', fullName: 'Tyler Reddick', team: '23XI Racing', madeLastYearChase: true, inCurrentChase: true, isBuschwhacker: false, active: true },
        { id: 'c8', nascarDriverId: 4008, seriesId: 1, carNumber: '48', fullName: 'Alex Bowman', team: 'Hendrick Motorsports', madeLastYearChase: true, inCurrentChase: true, isBuschwhacker: false, active: true },
        { id: 'c9', nascarDriverId: 4009, seriesId: 1, carNumber: '22', fullName: 'Joey Logano', team: 'Team Penske', madeLastYearChase: true, inCurrentChase: true, isBuschwhacker: false, active: true },

        // Cup Series - Non-Chase
        { id: 'cn1', nascarDriverId: 4101, seriesId: 1, carNumber: '8', fullName: 'Kyle Busch', team: 'Richard Childress Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'cn2', nascarDriverId: 4102, seriesId: 1, carNumber: '17', fullName: 'Chris Buescher', team: 'RFK Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'cn3', nascarDriverId: 4103, seriesId: 1, carNumber: '23', fullName: 'Bubba Wallace', team: '23XI Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'cn4', nascarDriverId: 4104, seriesId: 1, carNumber: '1', fullName: 'Ross Chastain', team: 'Trackhouse Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'cn5', nascarDriverId: 4105, seriesId: 1, carNumber: '54', fullName: 'Ty Gibbs', team: 'Joe Gibbs Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'cn6', nascarDriverId: 4106, seriesId: 1, carNumber: '71', fullName: 'Michael McDowell', team: 'Spire Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'cn7', nascarDriverId: 4107, seriesId: 1, carNumber: '6', fullName: 'Brad Keselowski', team: 'RFK Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'cn8', nascarDriverId: 4108, seriesId: 1, carNumber: '21', fullName: 'Josh Berry', team: 'Wood Brothers Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },

        // O'Reilly's Series - Regulars & Buschwhackers
        { id: 'o1', nascarDriverId: 5001, seriesId: 2, carNumber: '88', fullName: 'Connor Zilisch', team: 'JR Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'o2', nascarDriverId: 5002, seriesId: 2, carNumber: '7', fullName: 'Justin Allgaier', team: 'JR Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'o3', nascarDriverId: 5003, seriesId: 2, carNumber: '21', fullName: 'Austin Hill', team: 'Richard Childress Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'o4', nascarDriverId: 5004, seriesId: 2, carNumber: '2', fullName: 'Jesse Love', team: 'Richard Childress Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'o5', nascarDriverId: 5005, seriesId: 2, carNumber: '00', fullName: 'Sheldon Creed', team: 'Haas Factory Team', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'o6', nascarDriverId: 5006, seriesId: 2, carNumber: '1', fullName: 'Carson Kvapil', team: 'JR Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'o7', nascarDriverId: 5007, seriesId: 2, carNumber: '8', fullName: 'Sammy Smith', team: 'JR Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'o8', nascarDriverId: 5008, seriesId: 2, carNumber: '41', fullName: 'Sam Mayer', team: 'Haas Factory Team', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 'o_bw1', nascarDriverId: 4001, seriesId: 2, carNumber: '17', fullName: 'Kyle Larson', team: 'Hendrick Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: true, active: true },
        { id: 'o_bw2', nascarDriverId: 4006, seriesId: 2, carNumber: '9', fullName: 'Chase Elliott', team: 'JR Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: true, active: true },

        // Truck Series - Regulars & Buschwhacker
        { id: 't1', nascarDriverId: 6001, seriesId: 3, carNumber: '11', fullName: 'Corey Heim', team: 'TRICON Garage', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 't2', nascarDriverId: 6002, seriesId: 3, carNumber: '34', fullName: 'Layne Riggs', team: 'Front Row Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 't3', nascarDriverId: 6003, seriesId: 3, carNumber: '98', fullName: 'Ty Majeski', team: 'ThorSport Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 't4', nascarDriverId: 6004, seriesId: 3, carNumber: '9', fullName: 'Grant Enfinger', team: 'CR7 Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 't5', nascarDriverId: 6005, seriesId: 3, carNumber: '19', fullName: 'Christian Eckes', team: 'McAnally-Hilgemann', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 't6', nascarDriverId: 6006, seriesId: 3, carNumber: '71', fullName: 'Rajah Caruth', team: 'Spire Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 't7', nascarDriverId: 6007, seriesId: 3, carNumber: '38', fullName: 'Chandler Smith', team: 'Front Row Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 't8', nascarDriverId: 6008, seriesId: 3, carNumber: '52', fullName: 'Stewart Friesen', team: 'Halmar Friesen Racing', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: false, active: true },
        { id: 't_bw1', nascarDriverId: 4101, seriesId: 3, carNumber: '7', fullName: 'Kyle Busch', team: 'Spire Motorsports', madeLastYearChase: false, inCurrentChase: false, isBuschwhacker: true, active: true },
      ];

      await db.insert(drivers).values(canonicalDrivers).onConflictDoNothing();

      await db
        .insert(races)
        .values([
          {
            id: 'r_cup_bristol',
            nascarRaceId: 5501,
            seriesId: 1,
            weekendGroupId: '2026-W36',
            raceName: 'Bass Pro Shops Night Race',
            trackName: 'Bristol Motor Speedway',
            raceStartTime: new Date('2026-09-20T23:30:00Z'),
            isChaseRace: true,
            isLockedRevealed: false,
            isActiveWeekend: true,
            syncStatus: 'upcoming',
          },
          {
            id: 'r_oreillys_bristol',
            nascarRaceId: 5502,
            seriesId: 2,
            weekendGroupId: '2026-W36',
            raceName: 'Food City 300',
            trackName: 'Bristol Motor Speedway',
            raceStartTime: new Date('2026-09-19T23:30:00Z'),
            isChaseRace: false,
            isLockedRevealed: false,
            isActiveWeekend: true,
            syncStatus: 'upcoming',
          },
          {
            id: 'r_trucks_bristol',
            nascarRaceId: 5503,
            seriesId: 3,
            weekendGroupId: '2026-W36',
            raceName: 'UNOH 200',
            trackName: 'Bristol Motor Speedway',
            raceStartTime: new Date('2026-09-18T00:00:00Z'),
            isChaseRace: false,
            isLockedRevealed: false,
            isActiveWeekend: true,
            syncStatus: 'upcoming',
          },
        ])
        .onConflictDoNothing();

      referenceSeeded = true;
    } catch (error) {
      seedPromise = null;
      throw error;
    }
  })();

  return seedPromise;
}

/**
 * Returns non-sensitive league bootstrap info for the unauthenticated Login Homescreen.
 */
export async function getAuthBootstrapInfo() {
  await ensureReferenceDataSeeded();
  const [allUsers, settingsRows] = await Promise.all([
    db.select().from(users),
    db.select().from(leagueSettings).where(eq(leagueSettings.id, 'default')),
  ]);

  const activeUsers = allUsers.filter((u) => Boolean(u.passwordHash));
  const hasAdmin = activeUsers.some((u) => u.role === 'admin');

  return {
    hasAdmin,
    memberCount: activeUsers.length,
    leagueName: settingsRows[0]?.leagueName || 'Pit Box Fantasy League',
  };
}

/**
 * Fetches an authenticated user profile by ID without exposing `passwordHash`.
 */
export async function getUserById(userId: string) {
  await ensureReferenceDataSeeded();
  const rows = await db.select().from(users).where(eq(users.id, userId));
  if (rows.length === 0 || !rows[0].passwordHash) return null;
  return sanitizeUser(rows[0]);
}

function buildAvatarInitials(name: string): string {
  const letters = name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  return letters || 'PB';
}

/**
 * Registers a user account. First account automatically becomes League Commissioner; later sign-ups verify invite code.
 */
export async function registerAccount(params: {
  name: string;
  email: string;
  password: string;
  inviteCode?: string;
  leagueName?: string;
}) {
  await ensureReferenceDataSeeded();

  const cleanName = params.name.trim();
  const cleanEmail = params.email.trim().toLowerCase();
  const password = params.password || '';

  if (cleanName.length < 2) {
    throw new Error('Manager or Team Name must be at least 2 characters.');
  }
  if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) {
    throw new Error('Please enter a valid email address.');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  let existingUsers = await db.select().from(users);
  const hasAdmin = existingUsers.some(
    (u) => u.role === 'admin' && Boolean(u.passwordHash)
  );

  let assignedRole: 'admin' | 'member' = 'member';

  if (!hasAdmin) {
    // Clean up any stale passwordless orphaned rows left over from unauthenticated onboarding
    const orphanUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(isNull(users.passwordHash));

    for (const orphan of orphanUsers) {
      await db.delete(weeklyPicks).where(eq(weeklyPicks.userId, orphan.id));
      await db.delete(seasonRosters).where(eq(seasonRosters.userId, orphan.id));
      await db.delete(users).where(eq(users.id, orphan.id));
    }

    existingUsers = await db.select().from(users);
    assignedRole = 'admin';

    const settingsUpdate: Partial<typeof leagueSettings.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (params.leagueName && params.leagueName.trim()) {
      settingsUpdate.leagueName = params.leagueName.trim();
    }
    if (params.inviteCode && params.inviteCode.trim()) {
      settingsUpdate.inviteCode = params.inviteCode.trim().toUpperCase();
    }
    if (settingsUpdate.leagueName || settingsUpdate.inviteCode) {
      await db
        .update(leagueSettings)
        .set(settingsUpdate)
        .where(eq(leagueSettings.id, 'default'));
    }
  } else {
    const settingsRows = await db
      .select()
      .from(leagueSettings)
      .where(eq(leagueSettings.id, 'default'));
    const expectedCode = (settingsRows[0]?.inviteCode || 'PITBOX-2026')
      .trim()
      .toUpperCase();
    const submittedCode = (params.inviteCode || '').trim().toUpperCase();
    if (!submittedCode || submittedCode !== expectedCode) {
      throw new Error(
        'Invalid League Invite Code. Ask your Commissioner for the current code.'
      );
    }
  }

  if (existingUsers.some((u) => u.email.toLowerCase() === cleanEmail)) {
    throw new Error('An account with that email already exists. Please sign in.');
  }

  const activeCount = existingUsers.filter((u) => Boolean(u.passwordHash)).length;
  const newId = `u_${crypto.randomBytes(6).toString('hex')}`;
  const inserted = await db
    .insert(users)
    .values({
      id: newId,
      uid: `local_${newId}`,
      email: cleanEmail,
      passwordHash: hashPassword(password),
      name: cleanName,
      avatar: buildAvatarInitials(cleanName),
      lastYearRank: activeCount + 1,
      role: assignedRole,
      cumulativePriorPoints: 0,
    })
    .returning();

  return sanitizeUser(inserted[0]);
}

/**
 * Verifies email and password and returns the sanitized user record.
 */
export async function loginAccount(params: { email: string; password: string }) {
  await ensureReferenceDataSeeded();
  const cleanEmail = (params.email || '').trim().toLowerCase();
  const password = params.password || '';

  if (!cleanEmail || !password) {
    throw new Error('Invalid email or password.');
  }

  const allUsers = await db.select().from(users);
  const matched = allUsers.find((u) => u.email.toLowerCase() === cleanEmail);

  if (!matched || !verifyPassword(password, matched.passwordHash)) {
    throw new Error('Invalid email or password.');
  }

  return sanitizeUser(matched);
}

/**
 * Allows the League Commissioner to create an authenticated member account directly without invite codes.
 */
export async function adminCreateMember(params: {
  adminUserId: string;
  name: string;
  email: string;
  password: string;
}) {
  await ensureReferenceDataSeeded();
  await verifyAdminUser(params.adminUserId);

  const cleanName = (params.name || '').trim();
  const cleanEmail = (params.email || '').trim().toLowerCase();
  const password = params.password || '';

  if (cleanName.length < 2) {
    throw new Error('Manager or Team Name must be at least 2 characters.');
  }
  if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) {
    throw new Error('Please enter a valid email address.');
  }
  if (password.length < 6) {
    throw new Error('Initial password must be at least 6 characters.');
  }

  const existingUsers = await db.select().from(users);
  if (existingUsers.some((u) => u.email.toLowerCase() === cleanEmail)) {
    throw new Error('An account with that email already exists.');
  }

  const newId = `u_${crypto.randomBytes(6).toString('hex')}`;
  const inserted = await db
    .insert(users)
    .values({
      id: newId,
      uid: `local_${newId}`,
      email: cleanEmail,
      passwordHash: hashPassword(password),
      name: cleanName,
      avatar: buildAvatarInitials(cleanName),
      lastYearRank: existingUsers.length + 1,
      role: 'member',
      cumulativePriorPoints: 0,
    })
    .returning();

  return sanitizeUser(inserted[0]);
}

export function buildWeekendSimulationFeeds(
  firstPlacePoints: 55 | 40,
  simulateZilischInjury: boolean
): Record<1 | 2 | 3, ComputedRaceResult[]> {
  // 1. CUP SERIES (Sunday)
  const cupRaw: NascarFeedResult[] = [
    { driver_id: 4001, driver_fullname: 'Kyle Larson', car_number: '5', team_name: 'Hendrick Motorsports', finishing_position: 1, points_earned: firstPlacePoints + 10, fastest_lap: true },
    { driver_id: 4003, driver_fullname: 'Ryan Blaney', car_number: '12', team_name: 'Team Penske', finishing_position: 2, points_earned: 35 + 8 },
    { driver_id: 4004, driver_fullname: 'Christopher Bell', car_number: '20', team_name: 'Joe Gibbs Racing', finishing_position: 3, points_earned: 34 + 6 },
    { driver_id: 4002, driver_fullname: 'William Byron', car_number: '24', team_name: 'Hendrick Motorsports', finishing_position: 4, points_earned: 33 + 5 },
    { driver_id: 4101, driver_fullname: 'Kyle Busch', car_number: '8', team_name: 'Richard Childress Racing', finishing_position: 5, points_earned: 32 + 4 },
    { driver_id: 4005, driver_fullname: 'Denny Hamlin', car_number: '11', team_name: 'Joe Gibbs Racing', finishing_position: 6, points_earned: 31 + 2 },
    { driver_id: 4006, driver_fullname: 'Chase Elliott', car_number: '9', team_name: 'Hendrick Motorsports', finishing_position: 7, points_earned: 30 + 3 },
    { driver_id: 4102, driver_fullname: 'Chris Buescher', car_number: '17', team_name: 'RFK Racing', finishing_position: 8, points_earned: 29 },
    { driver_id: 4104, driver_fullname: 'Ross Chastain', car_number: '1', team_name: 'Trackhouse Racing', finishing_position: 9, points_earned: 28 },
    { driver_id: 4007, driver_fullname: 'Tyler Reddick', car_number: '45', team_name: '23XI Racing', finishing_position: 10, points_earned: 27 + 4 },
    { driver_id: 4008, driver_fullname: 'Alex Bowman', car_number: '48', team_name: 'Hendrick Motorsports', finishing_position: 11, points_earned: 26 },
    { driver_id: 4103, driver_fullname: 'Bubba Wallace', car_number: '23', team_name: '23XI Racing', finishing_position: 12, points_earned: 25 },
    { driver_id: 4009, driver_fullname: 'Joey Logano', car_number: '22', team_name: 'Team Penske', finishing_position: 13, points_earned: 24 },
    { driver_id: 4105, driver_fullname: 'Ty Gibbs', car_number: '54', team_name: 'Joe Gibbs Racing', finishing_position: 14, points_earned: 23 },
    { driver_id: 4107, driver_fullname: 'Brad Keselowski', car_number: '6', team_name: 'RFK Racing', finishing_position: 15, points_earned: 22 },
    { driver_id: 4108, driver_fullname: 'Josh Berry', car_number: '21', team_name: 'Wood Brothers Racing', finishing_position: 16, points_earned: 21 },
    { driver_id: 4106, driver_fullname: 'Michael McDowell', car_number: '71', team_name: 'Spire Motorsports', finishing_position: 18, points_earned: 19 },
  ];
  const cupStages: NascarStageFeed[] = [
    { stage_num: 1, results: [{ driver_id: 4001, car_number: '5', stage_points: 10 }, { driver_id: 4003, car_number: '12', stage_points: 8 }, { driver_id: 4007, car_number: '45', stage_points: 4 }] },
  ];

  // 2. O'REILLY'S SERIES (Saturday) - Features Buschwhackers (points_earned: 0) & Car Anchor Sub
  const oreillysRaw: NascarFeedResult[] = [
    {
      driver_id: 4001,
      driver_fullname: 'Kyle Larson',
      car_number: simulateZilischInjury ? '88' : '17',
      team_name: simulateZilischInjury ? 'JR Motorsports (Relief Sub)' : 'Hendrick Motorsports',
      finishing_position: 1,
      points_earned: 0, // BUSCHWHACKER RULE TRIGGER: 0 Official Driver Points!
      fastest_lap: true,
    },
    {
      driver_id: 4006,
      driver_fullname: 'Chase Elliott',
      car_number: '9',
      team_name: 'JR Motorsports',
      finishing_position: 2,
      points_earned: 0, // BUSCHWHACKER RULE TRIGGER: 2nd (35) + Stage (14) = 49 Owner Pts!
    },
    ...(!simulateZilischInjury
      ? [
          {
            driver_id: 5001,
            driver_fullname: 'Connor Zilisch',
            car_number: '88',
            team_name: 'JR Motorsports',
            finishing_position: 3,
            points_earned: 42,
          },
        ]
      : []),
    { driver_id: 5002, driver_fullname: 'Justin Allgaier', car_number: '7', team_name: 'JR Motorsports', finishing_position: 4, points_earned: 41 },
    { driver_id: 5003, driver_fullname: 'Austin Hill', car_number: '21', team_name: 'Richard Childress Racing', finishing_position: 5, points_earned: 36 },
    { driver_id: 5004, driver_fullname: 'Jesse Love', car_number: '2', team_name: 'Richard Childress Racing', finishing_position: 6, points_earned: 34 },
    { driver_id: 5007, driver_fullname: 'Sammy Smith', car_number: '8', team_name: 'JR Motorsports', finishing_position: 7, points_earned: 32 },
    { driver_id: 5005, driver_fullname: 'Sheldon Creed', car_number: '00', team_name: 'Haas Factory Team', finishing_position: 8, points_earned: 30 },
    { driver_id: 5008, driver_fullname: 'Sam Mayer', car_number: '41', team_name: 'Haas Factory Team', finishing_position: 9, points_earned: 29 },
    { driver_id: 5006, driver_fullname: 'Carson Kvapil', car_number: '1', team_name: 'JR Motorsports', finishing_position: 10, points_earned: 27 },
  ];

  const oreillysStages: NascarStageFeed[] = [
    {
      stage_num: 1,
      results: [
        { driver_id: 4001, car_number: simulateZilischInjury ? '88' : '17', stage_points: 10 },
        { driver_id: 4006, car_number: '9', stage_points: 7 },
        { driver_id: 5002, car_number: '7', stage_points: 8 },
      ],
    },
    {
      stage_num: 2,
      results: [
        { driver_id: 4001, car_number: simulateZilischInjury ? '88' : '17', stage_points: 9 },
        { driver_id: 4006, car_number: '9', stage_points: 7 },
      ],
    },
  ];

  // 3. TRUCK SERIES (Friday)
  const trucksRaw: NascarFeedResult[] = [
    {
      driver_id: 4101,
      driver_fullname: 'Kyle Busch',
      car_number: '7',
      team_name: 'Spire Motorsports',
      finishing_position: 1,
      points_earned: 0, // BUSCHWHACKER: 0 Driver pts, 1st (55/40) + 18 Stage + 1 FL = 74/59 Owner Pts!
      fastest_lap: true,
    },
    { driver_id: 6001, driver_fullname: 'Corey Heim', car_number: '11', team_name: 'TRICON Garage', finishing_position: 2, points_earned: 48 },
    { driver_id: 6003, driver_fullname: 'Ty Majeski', car_number: '98', team_name: 'ThorSport Racing', finishing_position: 3, points_earned: 42 },
    { driver_id: 6007, driver_fullname: 'Chandler Smith', car_number: '38', team_name: 'Front Row Motorsports', finishing_position: 4, points_earned: 39 },
    { driver_id: 6004, driver_fullname: 'Grant Enfinger', car_number: '9', team_name: 'CR7 Motorsports', finishing_position: 5, points_earned: 35 },
    { driver_id: 6005, driver_fullname: 'Christian Eckes', car_number: '19', team_name: 'McAnally-Hilgemann', finishing_position: 7, points_earned: 31 },
    { driver_id: 6008, driver_fullname: 'Stewart Friesen', car_number: '52', team_name: 'Halmar Friesen Racing', finishing_position: 9, points_earned: 28 },
    { driver_id: 6006, driver_fullname: 'Rajah Caruth', car_number: '71', team_name: 'Spire Motorsports', finishing_position: 11, points_earned: 26 },
    { driver_id: 6002, driver_fullname: 'Layne Riggs', car_number: '34', team_name: 'Front Row Motorsports', finishing_position: 15, points_earned: 22 },
  ];

  const trucksStages: NascarStageFeed[] = [
    { stage_num: 1, results: [{ driver_id: 4101, car_number: '7', stage_points: 10 }] },
    { stage_num: 2, results: [{ driver_id: 4101, car_number: '7', stage_points: 8 }] },
  ];

  return {
    1: processRaceResultsWithOwnerFallback(cupRaw, cupStages, firstPlacePoints),
    2: processRaceResultsWithOwnerFallback(oreillysRaw, oreillysStages, firstPlacePoints),
    3: processRaceResultsWithOwnerFallback(trucksRaw, trucksStages, firstPlacePoints),
  };
}

export async function syncRaceResultsToDatabase(
  firstPlacePoints: 55 | 40,
  simulateZilischInjury: boolean
) {
  if (syncInProgressPromise) {
    return syncInProgressPromise;
  }

  syncInProgressPromise = (async () => {
    try {
      await ensureReferenceDataSeeded();
      const computedBySeries = buildWeekendSimulationFeeds(
        firstPlacePoints,
        simulateZilischInjury
      );
      const raceMap: Record<1 | 2 | 3, string> = {
        1: 'r_cup_bristol',
        2: 'r_oreillys_bristol',
        3: 'r_trucks_bristol',
      };

      const allDrivers = await db.select().from(drivers);

      // If simulating Connor Zilisch (#88, nascarDriverId 5001) DNS, remove his row from O'Reilly's race
      if (simulateZilischInjury) {
        await db
          .delete(raceDriverResults)
          .where(
            and(
              eq(raceDriverResults.raceId, 'r_oreillys_bristol'),
              eq(raceDriverResults.nascarDriverId, 5001)
            )
          );
      }

      for (const sId of [1, 2, 3] as const) {
        const raceId = raceMap[sId];
        const results = computedBySeries[sId];

        for (const r of results) {
          const matchedDriver = allDrivers.find(
            (d) => d.seriesId === sId && d.nascarDriverId === r.nascar_driver_id
          );

          await db
            .insert(raceDriverResults)
            .values({
              raceId,
              driverId: matchedDriver?.id ?? null,
              nascarDriverId: r.nascar_driver_id,
              driverFullname: r.driver_fullname,
              actualCarNumber: r.actual_car_number,
              actualTeamName: r.actual_team_name,
              finishPosition: r.finish_position,
              stagePoints: r.stage_points,
              fastestLapBonus: r.fastest_lap_bonus,
              driverPoints: r.driver_points,
              calculatedOwnerPoints: r.calculated_owner_points,
              effectiveFantasyPoints: r.effective_fantasy_points,
              scoringSource: r.scoring_source,
              isDisqualified: r.is_disqualified,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                raceDriverResults.raceId,
                raceDriverResults.nascarDriverId,
              ],
              set: {
                driverId: matchedDriver?.id ?? null,
                driverFullname: r.driver_fullname,
                actualCarNumber: r.actual_car_number,
                actualTeamName: r.actual_team_name,
                finishPosition: r.finish_position,
                stagePoints: r.stage_points,
                fastestLapBonus: r.fastest_lap_bonus,
                driverPoints: r.driver_points,
                calculatedOwnerPoints: r.calculated_owner_points,
                effectiveFantasyPoints: r.effective_fantasy_points,
                scoringSource: r.scoring_source,
                isDisqualified: r.is_disqualified,
                updatedAt: new Date(),
              },
            });
        }

        await db
          .update(races)
          .set({ lastSyncedAt: new Date() })
          .where(eq(races.id, raceId));
      }

      return computedBySeries;
    } catch (error) {
      console.error('Database error in syncRaceResultsToDatabase:', error);
      throw new Error('Failed to persist race results to database.', {
        cause: error,
      });
    } finally {
      syncInProgressPromise = null;
    }
  })();

  return syncInProgressPromise;
}

export async function getFullLeagueState(viewer?: {
  id: string;
  role: string;
}) {
  try {
    await ensureReferenceDataSeeded();

    const [
      allUsers,
      allSettings,
      allSeries,
      allDrivers,
      allRaces,
      allRosters,
      allPicks,
      allResults,
    ] = await Promise.all([
      db.select().from(users),
      db.select().from(leagueSettings).where(eq(leagueSettings.id, 'default')),
      db.select().from(seriesConfig),
      db.select().from(drivers),
      db.select().from(races),
      db.select().from(seasonRosters),
      db.select().from(weeklyPicks),
      db.select().from(raceDriverResults),
    ]);

    let currentResults = allResults;
    if (currentResults.length === 0) {
      const cupSeries = allSeries.find((s) => s.id === 1);
      const fp = cupSeries?.firstPlacePoints === 40 ? 40 : 55;
      await syncRaceResultsToDatabase(fp, true);
      currentResults = await db.select().from(raceDriverResults);
    }

    const raceLockedMap = new Map(
      allRaces.map((r) => [r.id, r.isLockedRevealed])
    );

    const maskedPicks = allPicks.map((p) => {
      const isLocked = Boolean(raceLockedMap.get(p.raceId));
      const canView =
        p.isHistorical ||
        isLocked ||
        (viewer && (viewer.role === 'admin' || p.userId === viewer.id));
      return canView ? p : { ...p, driverId: '__HIDDEN__' };
    });

    const settingsRow = allSettings[0];

    return {
      leagueSettings: {
        leagueName: settingsRow?.leagueName || 'Pit Box Fantasy League',
        inviteCode:
          viewer?.role === 'admin'
            ? settingsRow?.inviteCode || 'PITBOX-2026'
            : null,
      },
      users: allUsers.filter((u) => Boolean(u.passwordHash)).map(sanitizeUser),
      seriesConfig: allSeries,
      drivers: allDrivers,
      races: allRaces,
      seasonRosters: allRosters,
      weeklyPicks: maskedPicks,
      raceDriverResults: currentResults,
    };
  } catch (error) {
    console.error('Database error in getFullLeagueState:', error);
    throw new Error('Failed to load league state from database.', {
      cause: error,
    });
  }
}

export async function saveWeeklyPick(params: {
  userId: string;
  raceId: string;
  seriesId: number;
  driverId: string;
}) {
  try {
    const { userId, raceId, seriesId, driverId } = params;

    const targetRace = await db
      .select()
      .from(races)
      .where(eq(races.id, raceId));

    if (targetRace.length > 0 && targetRace[0].isLockedRevealed) {
      throw new Error('Race has already reached Green Flag lock.');
    }

    const seriesRow = await db
      .select()
      .from(seriesConfig)
      .where(eq(seriesConfig.id, seriesId));
    const maxUses = seriesRow[0]?.maxWeeklyUsesPerDriver ?? 5;

    const historicalUses = await db
      .select()
      .from(weeklyPicks)
      .where(
        and(
          eq(weeklyPicks.userId, userId),
          eq(weeklyPicks.driverId, driverId),
          eq(weeklyPicks.isHistorical, true)
        )
      );

    if (historicalUses.length >= maxUses) {
      throw new Error(
        `Driver has 0/${maxUses} uses remaining in your Driver Usage Bank.`
      );
    }

    const upserted = await db
      .insert(weeklyPicks)
      .values({
        userId,
        raceId,
        seriesId,
        driverId,
        trackLabel: targetRace[0]?.trackName || 'Bristol Night',
        isHistorical: false,
        submittedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [weeklyPicks.userId, weeklyPicks.raceId],
        set: {
          driverId,
          submittedAt: new Date(),
        },
      })
      .returning();

    return upserted[0];
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to save weekly pick.',
      { cause: error }
    );
  }
}

export async function updateSeasonRosterSlot(params: {
  userId: string;
  seriesId: number;
  slotType: string;
  driverId: string;
  fallbackCarNumber: string;
}) {
  try {
    const { userId, seriesId, slotType, driverId, fallbackCarNumber } = params;

    // Enforce exclusive season driver rule across the league EXCEPT 'cup_current_chase'
    if (slotType !== 'cup_current_chase') {
      const existingOwner = await db
        .select()
        .from(seasonRosters)
        .where(
          and(
            eq(seasonRosters.seriesId, seriesId),
            eq(seasonRosters.driverId, driverId),
            ne(seasonRosters.slotType, 'cup_current_chase'),
            ne(seasonRosters.userId, userId)
          )
        );

      if (existingOwner.length > 0) {
        throw new Error(
          'Exclusive Draft Rule: That driver is already locked on another manager’s season-long roster.'
        );
      }
    }

    const updated = await db
      .insert(seasonRosters)
      .values({
        userId,
        seriesId,
        slotType,
        driverId,
        fallbackCarNumber: fallbackCarNumber.replace('#', '').trim(),
      })
      .onConflictDoUpdate({
        target: [seasonRosters.userId, seasonRosters.slotType],
        set: {
          driverId,
          fallbackCarNumber: fallbackCarNumber.replace('#', '').trim(),
        },
      })
      .returning();

    return updated[0];
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to update season roster.',
      { cause: error }
    );
  }
}

export async function updateLeagueAdminSettings(params: {
  adminUserId: string;
  leagueName?: string;
  inviteCode?: string;
  firstPlacePoints?: 55 | 40;
  useCarAnchorFallback?: boolean;
  chaseActive?: boolean;
  simulateZilischInjury?: boolean;
  raceLocks?: Record<number, boolean>;
  activeSeriesWeekend?: Record<number, boolean>;
}) {
  try {
    await ensureReferenceDataSeeded();
    const admin = await verifyAdminUser(params.adminUserId);

    const settingsPatch: Partial<typeof leagueSettings.$inferInsert> = {};
    if (params.leagueName !== undefined && params.leagueName.trim()) {
      settingsPatch.leagueName = params.leagueName.trim();
    }
    if (params.inviteCode !== undefined && params.inviteCode.trim()) {
      settingsPatch.inviteCode = params.inviteCode.trim().toUpperCase();
    }
    if (Object.keys(settingsPatch).length > 0) {
      settingsPatch.updatedAt = new Date();
      await db
        .update(leagueSettings)
        .set(settingsPatch)
        .where(eq(leagueSettings.id, 'default'));
    }

    const currentSeries = await db.select().from(seriesConfig);
    const cupCfg = currentSeries.find((s) => s.id === 1);

    const nextFirstPlace: 55 | 40 =
      params.firstPlacePoints ?? (cupCfg?.firstPlacePoints === 40 ? 40 : 55);
    const nextCarAnchor =
      params.useCarAnchorFallback ?? cupCfg?.useCarAnchorFallback ?? true;
    const nextChaseActive = params.chaseActive ?? cupCfg?.chaseActive ?? true;

    for (const sId of [1, 2, 3]) {
      await db
        .update(seriesConfig)
        .set({
          firstPlacePoints: nextFirstPlace,
          useCarAnchorFallback: nextCarAnchor,
          chaseActive: nextChaseActive,
        })
        .where(eq(seriesConfig.id, sId));
    }

    const raceMap: Record<number, string> = {
      1: 'r_cup_bristol',
      2: 'r_oreillys_bristol',
      3: 'r_trucks_bristol',
    };

    if (params.raceLocks) {
      for (const [sIdStr, locked] of Object.entries(params.raceLocks)) {
        const rId = raceMap[Number(sIdStr)];
        if (rId) {
          await db
            .update(races)
            .set({
              isLockedRevealed: Boolean(locked),
              syncStatus: locked ? 'live' : 'upcoming',
            })
            .where(eq(races.id, rId));
        }
      }
    }

    if (params.activeSeriesWeekend) {
      for (const [sIdStr, isActive] of Object.entries(
        params.activeSeriesWeekend
      )) {
        const rId = raceMap[Number(sIdStr)];
        if (rId) {
          await db
            .update(races)
            .set({ isActiveWeekend: Boolean(isActive) })
            .where(eq(races.id, rId));
        }
      }
    }

    const simZilisch =
      params.simulateZilischInjury !== undefined
        ? params.simulateZilischInjury
        : true;

    await syncRaceResultsToDatabase(nextFirstPlace, simZilisch);
    return await getFullLeagueState({ id: admin.id, role: admin.role });
  } catch (error) {
    console.error('Database error in updateLeagueAdminSettings:', error);
    throw new Error(
      error instanceof Error
        ? error.message
        : 'Failed to update league admin settings.',
      { cause: error }
    );
  }
}

async function verifyAdminUser(adminUserId: string) {
  const rows = await db.select().from(users).where(eq(users.id, adminUserId));
  if (rows.length === 0 || rows[0].role !== 'admin') {
    throw new Error('Commissioner permission required to perform this action.');
  }
  return rows[0];
}

export async function adminUpdateTeam(params: {
  adminUserId: string;
  targetUserId: string;
  name?: string;
  role?: 'admin' | 'member';
  lastYearRank?: number;
  cumulativePriorPoints?: number;
}) {
  try {
    await verifyAdminUser(params.adminUserId);

    const targetRows = await db
      .select()
      .from(users)
      .where(eq(users.id, params.targetUserId));
    if (targetRows.length === 0) {
      throw new Error('Target manager not found.');
    }

    // Prevent demoting the last remaining commissioner
    if (params.role === 'member' && targetRows[0].role === 'admin') {
      const admins = await db
        .select()
        .from(users)
        .where(eq(users.role, 'admin'));
      if (admins.length <= 1) {
        throw new Error(
          'The league must have at least one Commissioner (admin). Promote another manager first.'
        );
      }
    }

    const updatePayload: Partial<typeof users.$inferInsert> = {};
    if (params.name !== undefined && params.name.trim()) {
      const cleanName = params.name.trim();
      updatePayload.name = cleanName;
      updatePayload.avatar =
        cleanName
          .replace(/\(.*?\)/g, '')
          .trim()
          .split(/\s+/)
          .map((w) => w[0])
          .join('')
          .toUpperCase()
          .slice(0, 2) || targetRows[0].avatar;
    }
    if (params.role === 'admin' || params.role === 'member') {
      updatePayload.role = params.role;
    }
    if (
      params.lastYearRank !== undefined &&
      Number.isFinite(params.lastYearRank)
    ) {
      updatePayload.lastYearRank = Math.max(1, Math.round(params.lastYearRank));
    }
    if (
      params.cumulativePriorPoints !== undefined &&
      Number.isFinite(params.cumulativePriorPoints)
    ) {
      updatePayload.cumulativePriorPoints = Math.round(
        params.cumulativePriorPoints
      );
    }

    if (Object.keys(updatePayload).length === 0) {
      return sanitizeUser(targetRows[0]);
    }

    const updated = await db
      .update(users)
      .set(updatePayload)
      .where(eq(users.id, params.targetUserId))
      .returning();

    return sanitizeUser(updated[0]);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to update team profile.',
      { cause: error }
    );
  }
}

export async function adminDeleteTeam(params: {
  adminUserId: string;
  targetUserId: string;
}) {
  try {
    await verifyAdminUser(params.adminUserId);
    if (params.adminUserId === params.targetUserId) {
      throw new Error('You cannot remove the active Commissioner team.');
    }

    const targetRows = await db
      .select()
      .from(users)
      .where(eq(users.id, params.targetUserId));
    if (targetRows.length === 0) {
      throw new Error('Team not found.');
    }

    if (targetRows[0].role === 'admin') {
      const admins = await db
        .select()
        .from(users)
        .where(eq(users.role, 'admin'));
      if (admins.length <= 1) {
        throw new Error('Cannot remove the only Commissioner.');
      }
    }

    await db
      .delete(weeklyPicks)
      .where(eq(weeklyPicks.userId, params.targetUserId));
    await db
      .delete(seasonRosters)
      .where(eq(seasonRosters.userId, params.targetUserId));
    await db.delete(users).where(eq(users.id, params.targetUserId));
    return { deleted: params.targetUserId };
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to delete team.',
      { cause: error }
    );
  }
}

export async function adminOverrideWeeklyPick(params: {
  adminUserId: string;
  targetUserId: string;
  raceId: string;
  seriesId: number;
  driverId: string;
}) {
  try {
    await verifyAdminUser(params.adminUserId);

    const targetRace = await db
      .select()
      .from(races)
      .where(eq(races.id, params.raceId));

    const upserted = await db
      .insert(weeklyPicks)
      .values({
        userId: params.targetUserId,
        raceId: params.raceId,
        seriesId: params.seriesId,
        driverId: params.driverId,
        trackLabel: targetRace[0]?.trackName || 'Bristol Night',
        isHistorical: false,
        submittedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [weeklyPicks.userId, weeklyPicks.raceId],
        set: {
          driverId: params.driverId,
          submittedAt: new Date(),
        },
      })
      .returning();

    return upserted[0];
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : 'Failed to override weekly pick.',
      { cause: error }
    );
  }
}

export async function adminUpdateSeasonSlot(params: {
  adminUserId: string;
  targetUserId: string;
  seriesId: number;
  slotType: string;
  driverId: string;
  fallbackCarNumber: string;
  forceReassign?: boolean;
}) {
  try {
    await verifyAdminUser(params.adminUserId);

    if (params.slotType !== 'cup_current_chase') {
      const existingOwner = await db
        .select()
        .from(seasonRosters)
        .where(
          and(
            eq(seasonRosters.seriesId, params.seriesId),
            eq(seasonRosters.driverId, params.driverId),
            ne(seasonRosters.slotType, 'cup_current_chase'),
            ne(seasonRosters.userId, params.targetUserId)
          )
        );

      if (existingOwner.length > 0) {
        if (params.forceReassign) {
          for (const conflict of existingOwner) {
            await db
              .delete(seasonRosters)
              .where(eq(seasonRosters.id, conflict.id));
          }
        } else {
          throw new Error(
            'That driver is currently assigned to another manager. Enable Force Reassign to move the driver.'
          );
        }
      }
    }

    const updated = await db
      .insert(seasonRosters)
      .values({
        userId: params.targetUserId,
        seriesId: params.seriesId,
        slotType: params.slotType,
        driverId: params.driverId,
        fallbackCarNumber: params.fallbackCarNumber.replace('#', '').trim(),
      })
      .onConflictDoUpdate({
        target: [seasonRosters.userId, seasonRosters.slotType],
        set: {
          driverId: params.driverId,
          fallbackCarNumber: params.fallbackCarNumber.replace('#', '').trim(),
        },
      })
      .returning();

    return updated[0];
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : 'Failed to adjust season roster slot.',
      { cause: error }
    );
  }
}

export async function resetExclusiveDraft(adminUserId: string) {
  try {
    await verifyAdminUser(adminUserId);
    await db
      .delete(seasonRosters)
      .where(ne(seasonRosters.slotType, 'cup_current_chase'));
    return { reset: true };
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : 'Failed to reset initial draft.',
      { cause: error }
    );
  }
}
