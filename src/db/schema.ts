import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// 1. USERS TABLE (Authenticated Accounts)
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  name: text('name').notNull(),
  avatar: text('avatar').notNull().default('PB'),
  lastYearRank: integer('last_year_rank').notNull().default(1),
  role: text('role').notNull().default('member'), // 'admin' | 'member'
  cumulativePriorPoints: integer('cumulative_prior_points').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// 1b. LEAGUE SETTINGS TABLE (Name & Invite Code managed by Commissioner)
export const leagueSettings = pgTable('league_settings', {
  id: text('id').primaryKey(), // canonical row 'default'
  leagueName: text('league_name').notNull().default('Pit Box Fantasy League'),
  inviteCode: text('invite_code').notNull().default('PITBOX-2026'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// 2. SERIES & LEAGUE CONFIG TABLE
export const seriesConfig = pgTable('series_config', {
  id: integer('id').primaryKey(), // 1 = Cup, 2 = O'Reilly's, 3 = Trucks
  name: text('name').notNull(),
  shortName: text('short_name').notNull(),
  badgeColor: text('badge_color').notNull(),
  maxWeeklyUsesPerDriver: integer('max_weekly_uses_per_driver').notNull().default(5),
  chaseActive: boolean('chase_active').notNull().default(true),
  firstPlacePoints: integer('first_place_points').notNull().default(55), // 55 or 40
  useCarAnchorFallback: boolean('use_car_anchor_fallback').notNull().default(true),
});

// 3. DRIVERS TABLE
export const drivers = pgTable(
  'drivers',
  {
    id: text('id').primaryKey(),
    nascarDriverId: integer('nascar_driver_id').notNull(),
    seriesId: integer('series_id')
      .notNull()
      .references(() => seriesConfig.id),
    carNumber: text('car_number').notNull(),
    fullName: text('full_name').notNull(),
    team: text('team').notNull(),
    madeLastYearChase: boolean('made_last_year_chase').notNull().default(false),
    inCurrentChase: boolean('in_current_chase').notNull().default(false),
    isBuschwhacker: boolean('is_buschwhacker').notNull().default(false),
    active: boolean('active').notNull().default(true),
  },
  (table) => ({
    driverSeriesIdx: uniqueIndex('idx_driver_series_nascar_id').on(
      table.nascarDriverId,
      table.seriesId
    ),
  })
);

// 4. RACES TABLE
export const races = pgTable('races', {
  id: text('id').primaryKey(),
  nascarRaceId: integer('nascar_race_id').notNull().unique(),
  seriesId: integer('series_id')
    .notNull()
    .references(() => seriesConfig.id),
  weekendGroupId: text('weekend_group_id').notNull(),
  raceName: text('race_name').notNull(),
  trackName: text('track_name').notNull(),
  raceStartTime: timestamp('race_start_time', { withTimezone: true }).notNull(),
  isChaseRace: boolean('is_chase_race').notNull().default(false),
  isLockedRevealed: boolean('is_locked_revealed').notNull().default(false),
  isActiveWeekend: boolean('is_active_weekend').notNull().default(true),
  syncStatus: text('sync_status').notNull().default('upcoming'), // 'upcoming' | 'live' | 'official'
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
});

// 5. SEASON ROSTERS TABLE (With Car Anchor Fallback)
export const seasonRosters = pgTable(
  'season_rosters',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    seriesId: integer('series_id')
      .notNull()
      .references(() => seriesConfig.id),
    slotType: text('slot_type').notNull(), // 'oreillys_season' | 'trucks_season' | 'cup_prev_chase' | 'cup_prev_non_chase' | 'cup_current_chase'
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id),
    fallbackCarNumber: text('fallback_car_number').notNull(),
  },
  (table) => ({
    userSlotUnique: uniqueIndex('idx_user_slot_unique').on(
      table.userId,
      table.slotType
    ),
  })
);

// 6. WEEKLY PICKS TABLE
export const weeklyPicks = pgTable(
  'weekly_picks',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    raceId: text('race_id')
      .notNull()
      .references(() => races.id),
    seriesId: integer('series_id')
      .notNull()
      .references(() => seriesConfig.id),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id),
    trackLabel: text('track_label'),
    isHistorical: boolean('is_historical').notNull().default(false),
    submittedAt: timestamp('submitted_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userRaceUnique: uniqueIndex('idx_user_race_pick').on(
      table.userId,
      table.raceId
    ),
  })
);

// 7. RACE DRIVER RESULTS TABLE (Upgraded for Buschwhacker & Ride-Swapping)
export const raceDriverResults = pgTable(
  'race_driver_results',
  {
    id: serial('id').primaryKey(),
    raceId: text('race_id')
      .notNull()
      .references(() => races.id),
    driverId: text('driver_id').references(() => drivers.id),
    nascarDriverId: integer('nascar_driver_id').notNull(),
    driverFullname: text('driver_fullname').notNull(),
    actualCarNumber: text('actual_car_number').notNull(),
    actualTeamName: text('actual_team_name').notNull(),
    finishPosition: integer('finish_position').notNull(),
    stagePoints: integer('stage_points').notNull().default(0),
    fastestLapBonus: integer('fastest_lap_bonus').notNull().default(0),
    driverPoints: integer('driver_points').notNull().default(0),
    calculatedOwnerPoints: integer('calculated_owner_points').notNull().default(0),
    effectiveFantasyPoints: integer('effective_fantasy_points').notNull().default(0),
    scoringSource: text('scoring_source').notNull().default('OFFICIAL_DRIVER_PTS'),
    isDisqualified: boolean('is_disqualified').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    raceDriverUnique: uniqueIndex('idx_race_nascar_driver').on(
      table.raceId,
      table.nascarDriverId
    ),
  })
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  seasonRosters: many(seasonRosters),
  weeklyPicks: many(weeklyPicks),
}));
