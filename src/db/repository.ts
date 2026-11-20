import { eq, and, ne } from 'drizzle-orm';
import { db } from './index.ts';
import {
  users,
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

let syncInProgressPromise: Promise<Record<1 | 2 | 3, ComputedRaceResult[]>> | null =
  null;

export async function getOrCreateUser(
  uid: string,
  email: string,
  displayName?: string
) {
  try {
    const existingByUid = await db
      .select()
      .from(users)
      .where(eq(users.uid, uid));

    if (existingByUid.length > 0) {
      const updated = await db
        .update(users)
        .set({
          email,
          name: displayName ? `${displayName} (You)` : existingByUid[0].name,
        })
        .where(eq(users.uid, uid))
        .returning();
      return updated[0];
    }

    const primarySeat = await db
      .select()
      .from(users)
      .where(eq(users.id, 'u1'));

    if (primarySeat.length > 0 && primarySeat[0].uid === 'seed-uid-u1') {
      const bound = await db
        .update(users)
        .set({
          uid,
          email,
          name: displayName ? `${displayName} (You)` : primarySeat[0].name,
        })
        .where(eq(users.id, 'u1'))
        .returning();
      return bound[0];
    }

    const avatarInitials = (displayName || email || 'PB')
      .split(' ')
      .map((p) => p[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);

    const result = await db
      .insert(users)
      .values({
        id: `user_${uid.slice(0, 8)}`,
        uid,
        email,
        name: displayName || email.split('@')[0] || 'Pit Box Manager',
        avatar: avatarInitials || 'PB',
        lastYearRank: 7,
        role: 'member',
        cumulativePriorPoints: 2250,
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email,
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Database error in getOrCreateUser:', error);
    throw new Error('Failed to synchronize user profile.', { cause: error });
  }
}

export async function joinLeagueMember(params: {
  name: string;
  email?: string;
  avatar?: string;
  inviteCode?: string;
}) {
  try {
    const cleanName = params.name.trim();
    if (!cleanName) {
      throw new Error('Please enter your Manager or Team Name.');
    }

    const allUsers = await db.select().from(users);
    const nextRank = allUsers.length + 1;
    const newId = `u_${Date.now().toString(36)}`;
    const initials =
      params.avatar?.trim().toUpperCase().slice(0, 2) ||
      cleanName
        .split(' ')
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2) ||
      'NP';

    const insertedUser = await db
      .insert(users)
      .values({
        id: newId,
        uid: `invite_${newId}`,
        email:
          params.email?.trim() ||
          `${cleanName.toLowerCase().replace(/[^a-z0-9]/g, '')}@pitboxfantasy.com`,
        name: cleanName,
        avatar: initials,
        lastYearRank: nextRank,
        role: 'member',
        cumulativePriorPoints: 2300,
      })
      .returning();

    // Check whether teams already have drafted exclusive rosters
    const allRosters = await db.select().from(seasonRosters);
    const hasActiveExclusiveRosters = allRosters.some(
      (r) => r.slotType !== 'cup_current_chase'
    );

    if (hasActiveExclusiveRosters) {
      const allDrivers = await db.select().from(drivers);
      const takenIds = new Set(
        allRosters
          .filter((r) => r.slotType !== 'cup_current_chase')
          .map((r) => r.driverId)
      );

      const pickOpenDriver = (
        sId: number,
        filterFn: (d: typeof allDrivers[0]) => boolean
      ) =>
        allDrivers.find(
          (d) =>
            d.seriesId === sId &&
            !d.isBuschwhacker &&
            !takenIds.has(d.id) &&
            filterFn(d)
        );

      const cupChaseDrv = pickOpenDriver(1, (d) => d.madeLastYearChase);
      if (cupChaseDrv) takenIds.add(cupChaseDrv.id);
      const cupNonChaseDrv = pickOpenDriver(1, (d) => !d.madeLastYearChase);
      if (cupNonChaseDrv) takenIds.add(cupNonChaseDrv.id);
      const oreillyDrv = pickOpenDriver(2, () => true);
      if (oreillyDrv) takenIds.add(oreillyDrv.id);
      const truckDrv = pickOpenDriver(3, () => true);
      if (truckDrv) takenIds.add(truckDrv.id);

      const starterSlots = [
        cupChaseDrv && {
          seriesId: 1,
          slotType: 'cup_prev_chase',
          driverId: cupChaseDrv.id,
          fallbackCarNumber: cupChaseDrv.carNumber,
        },
        cupNonChaseDrv && {
          seriesId: 1,
          slotType: 'cup_prev_non_chase',
          driverId: cupNonChaseDrv.id,
          fallbackCarNumber: cupNonChaseDrv.carNumber,
        },
        oreillyDrv && {
          seriesId: 2,
          slotType: 'oreillys_season',
          driverId: oreillyDrv.id,
          fallbackCarNumber: oreillyDrv.carNumber,
        },
        truckDrv && {
          seriesId: 3,
          slotType: 'trucks_season',
          driverId: truckDrv.id,
          fallbackCarNumber: truckDrv.carNumber,
        },
        {
          seriesId: 1,
          slotType: 'cup_current_chase',
          driverId: 'c1',
          fallbackCarNumber: '5',
        },
      ].filter(Boolean) as Array<{
        seriesId: number;
        slotType: string;
        driverId: string;
        fallbackCarNumber: string;
      }>;

      for (const s of starterSlots) {
        await db
          .insert(seasonRosters)
          .values({
            userId: newId,
            seriesId: s.seriesId,
            slotType: s.slotType,
            driverId: s.driverId,
            fallbackCarNumber: s.fallbackCarNumber,
          })
          .onConflictDoNothing();
      }
    }

    // Assign default weekly picks for the active weekend
    const defaultWeekly = [
      { raceId: 'r_cup_bristol', seriesId: 1, driverId: 'c7' },
      { raceId: 'r_oreillys_bristol', seriesId: 2, driverId: 'o_bw1' },
      { raceId: 'r_trucks_bristol', seriesId: 3, driverId: 't_bw1' },
    ];

    for (const wp of defaultWeekly) {
      await db
        .insert(weeklyPicks)
        .values({
          userId: newId,
          raceId: wp.raceId,
          seriesId: wp.seriesId,
          driverId: wp.driverId,
          trackLabel: 'Bristol Night',
          isHistorical: false,
        })
        .onConflictDoNothing();
    }

    return insertedUser[0];
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to join league.',
      { cause: error }
    );
  }
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

export async function getFullLeagueState() {
  try {
    const [
      allUsers,
      allSeries,
      allDrivers,
      allRaces,
      allRosters,
      allPicks,
      allResults,
    ] = await Promise.all([
      db.select().from(users),
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

    return {
      users: allUsers,
      seriesConfig: allSeries,
      drivers: allDrivers,
      races: allRaces,
      seasonRosters: allRosters,
      weeklyPicks: allPicks,
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
  firstPlacePoints?: 55 | 40;
  useCarAnchorFallback?: boolean;
  chaseActive?: boolean;
  simulateZilischInjury?: boolean;
  raceLocks?: Record<number, boolean>;
  activeSeriesWeekend?: Record<number, boolean>;
}) {
  try {
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
    return await getFullLeagueState();
  } catch (error) {
    console.error('Database error in updateLeagueAdminSettings:', error);
    throw new Error('Failed to update league admin settings.', {
      cause: error,
    });
  }
}

async function verifyAdminUser(adminUserId: string) {
  const rows = await db.select().from(users).where(eq(users.id, adminUserId));
  if (rows.length === 0 || rows[0].role !== 'admin') {
    throw new Error(
      'Commissioner permission required: switch to a Commissioner account to perform this action.'
    );
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
      return targetRows[0];
    }

    const updated = await db
      .update(users)
      .set(updatePayload)
      .where(eq(users.id, params.targetUserId))
      .returning();

    return updated[0];
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

export async function claimAdminWithPasscode(params: {
  targetUserId: string;
  passcode: string;
}) {
  try {
    const cleanCode = params.passcode.trim().toUpperCase();
    if (cleanCode !== 'COMMISH-2026' && cleanCode !== 'PITBOX-ADMIN') {
      throw new Error('Invalid Commissioner passcode.');
    }
    const updated = await db
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, params.targetUserId))
      .returning();
    if (updated.length === 0) {
      throw new Error('Manager not found.');
    }
    return updated[0];
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : 'Failed to claim Commissioner role.',
      { cause: error }
    );
  }
}
