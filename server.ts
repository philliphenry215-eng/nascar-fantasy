import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import {
  ensureReferenceDataSeeded,
  getAuthBootstrapInfo,
  getUserById,
  registerAccount,
  loginAccount,
  adminCreateMember,
  getFullLeagueState,
  saveWeeklyPick,
  updateSeasonRosterSlot,
  updateLeagueAdminSettings,
  syncRaceResultsToDatabase,
  adminUpdateTeam,
  adminDeleteTeam,
  adminOverrideWeeklyPick,
  adminUpdateSeasonSlot,
  resetExclusiveDraft,
  upsertRaceEntriesFromFeed,
  adminAddDriver,
  adminToggleRaceEntry,
} from './src/db/repository.ts';
import {
  parseCookies,
  verifySessionToken,
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE_NAME,
} from './src/lib/session.ts';
import {
  processRaceResultsWithOwnerFallback,
  NascarFeedResult,
  NascarStageFeed,
} from './src/lib/nascar-scoring-engine.ts';

dotenv.config();

const NASCAR_CDN_BASE = 'https://cf.nascar.com';

export interface SessionUser {
  id: string;
  uid: string;
  email: string;
  name: string;
  avatar: string;
  role: string;
  lastYearRank: number;
  cumulativePriorPoints: number;
}

interface SessionRequest extends Request {
  sessionUser?: SessionUser;
}

async function resolveSessionUser(req: Request): Promise<SessionUser | null> {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken) return null;

  const verified = verifySessionToken(rawToken);
  if (!verified) return null;

  const user = await getUserById(verified.uid);
  if (!user) return null;
  return user;
}

const requireSession = async (
  req: SessionRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = await resolveSessionUser(req);
    if (!user) {
      return res
        .status(401)
        .json({ ok: false, error: 'Authentication required' });
    }
    req.sessionUser = user;
    next();
  } catch (error) {
    console.error('Session lookup error:', error);
    return res
      .status(401)
      .json({ ok: false, error: 'Authentication required' });
  }
};

const requireAdminSession = async (
  req: SessionRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = await resolveSessionUser(req);
    if (!user) {
      return res
        .status(401)
        .json({ ok: false, error: 'Authentication required' });
    }
    if (user.role !== 'admin') {
      return res
        .status(403)
        .json({ ok: false, error: 'Commissioner permission required' });
    }
    req.sessionUser = user;
    next();
  } catch (error) {
    console.error('Admin session check error:', error);
    return res
      .status(401)
      .json({ ok: false, error: 'Authentication required' });
  }
};

function getWeekendGroupId(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '2026-W36';
  const year = d.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - startOfYear.getTime()) / 86400000 +
      startOfYear.getUTCDay() +
      1) /
      7
  );
  return `${year}-W${String(weekNo).padStart(2, '0')}`;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.set('trust proxy', 1);
  app.use(express.json());

  // Seed canonical NASCAR reference tables on boot without fake users or picks
  ensureReferenceDataSeeded().catch((err) =>
    console.error('Initial reference seed check failed:', err)
  );

  // ==========================================
  // PUBLIC AUTHENTICATION ROUTES
  // ==========================================

  app.get('/api/auth/me', async (req, res) => {
    try {
      const user = await resolveSessionUser(req);
      if (user) {
        return res.json({ ok: true, authenticated: true, user });
      }
      const bootstrap = await getAuthBootstrapInfo();
      return res.json({
        ok: true,
        authenticated: false,
        ...bootstrap,
      });
    } catch (error: any) {
      console.error('Error in /api/auth/me:', error);
      return res.status(500).json({
        ok: false,
        error: error.message || 'Failed to check session status',
      });
    }
  });

  app.post('/api/auth/register', async (req, res) => {
    try {
      const { name, email, password, inviteCode, leagueName } = req.body || {};
      const user = await registerAccount({
        name: String(name || ''),
        email: String(email || ''),
        password: String(password || ''),
        inviteCode: inviteCode ? String(inviteCode) : undefined,
        leagueName: leagueName ? String(leagueName) : undefined,
      });
      setSessionCookie(res, user.id);
      const state = await getFullLeagueState(user);
      return res.json({ ok: true, user, state });
    } catch (error: any) {
      return res.status(400).json({
        ok: false,
        error: error.message || 'Failed to create account',
      });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const user = await loginAccount({
        email: String(email || ''),
        password: String(password || ''),
      });
      setSessionCookie(res, user.id);
      const state = await getFullLeagueState(user);
      return res.json({ ok: true, user, state });
    } catch (error: any) {
      return res.status(401).json({
        ok: false,
        error: error.message || 'Invalid email or password',
      });
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  // ==========================================
  // PROTECTED LEAGUE ROUTES (Session Required)
  // ==========================================

  // 1. Fetch PostgreSQL-backed league state (blind picks masked for non-admins)
  app.get(
    '/api/league-state',
    requireSession,
    async (req: SessionRequest, res) => {
      try {
        const state = await getFullLeagueState(req.sessionUser!);
        res.json({ ok: true, state });
      } catch (error: any) {
        console.error('Failed to fetch league state:', error);
        res.status(500).json({
          ok: false,
          error: error.message || 'Failed to load league state',
        });
      }
    }
  );

  // 2. Submit or update own Weekly Pick in PostgreSQL
  app.post(
    '/api/weekly-pick',
    requireSession,
    async (req: SessionRequest, res) => {
      try {
        const { raceId, seriesId, driverId } = req.body || {};
        if (!raceId || !seriesId || !driverId) {
          return res
            .status(400)
            .json({ ok: false, error: 'Missing pick fields' });
        }
        await saveWeeklyPick({
          userId: req.sessionUser!.id,
          raceId: String(raceId),
          seriesId: Number(seriesId),
          driverId: String(driverId),
        });
        const state = await getFullLeagueState(req.sessionUser!);
        res.json({ ok: true, state });
      } catch (error: any) {
        res.status(400).json({
          ok: false,
          error: error.message || 'Failed to save weekly pick',
        });
      }
    }
  );

  // 3. Update own Season-Long Roster Slot or Car Anchor Fallback in PostgreSQL
  app.post(
    '/api/season-roster',
    requireSession,
    async (req: SessionRequest, res) => {
      try {
        const { seriesId, slotType, driverId, fallbackCarNumber } =
          req.body || {};
        if (!seriesId || !slotType || !driverId || !fallbackCarNumber) {
          return res
            .status(400)
            .json({ ok: false, error: 'Missing season roster fields' });
        }
        await updateSeasonRosterSlot({
          userId: req.sessionUser!.id,
          seriesId: Number(seriesId),
          slotType: String(slotType),
          driverId: String(driverId),
          fallbackCarNumber: String(fallbackCarNumber),
          allowOverwrite: req.sessionUser!.role === 'admin',
        });
        const state = await getFullLeagueState(req.sessionUser!);
        res.json({ ok: true, state });
      } catch (error: any) {
        res.status(400).json({
          ok: false,
          error: error.message || 'Failed to update season roster',
        });
      }
    }
  );

  // 4. Update Commissioner Admin Settings & League Invite Config (Admin Only)
  app.post(
    '/api/admin/settings',
    requireAdminSession,
    async (req: SessionRequest, res) => {
      try {
        const state = await updateLeagueAdminSettings({
          ...(req.body || {}),
          adminUserId: req.sessionUser!.id,
        });
        res.json({ ok: true, state });
      } catch (error: any) {
        console.error('Failed to update commissioner settings:', error);
        res.status(400).json({
          ok: false,
          error: error.message || 'Failed to update commissioner settings',
        });
      }
    }
  );

  // 5. Commissioner Team Management (Admin Only)
  app.post(
    '/api/admin/team',
    requireAdminSession,
    async (req: SessionRequest, res) => {
      try {
        const body = req.body || {};
        const { action, targetUserId } = body;
        const adminUserId = req.sessionUser!.id;

        if (action === 'create_member') {
          await adminCreateMember({
            adminUserId,
            name: String(body.name || ''),
            email: String(body.email || ''),
            password: String(body.password || ''),
          });
        } else if (action === 'update_profile') {
          await adminUpdateTeam({
            adminUserId,
            targetUserId: String(targetUserId || ''),
            name: body.name,
            role: body.role,
            lastYearRank:
              body.lastYearRank !== undefined
                ? Number(body.lastYearRank)
                : undefined,
            cumulativePriorPoints:
              body.cumulativePriorPoints !== undefined
                ? Number(body.cumulativePriorPoints)
                : undefined,
          });
        } else if (action === 'delete_team') {
          await adminDeleteTeam({
            adminUserId,
            targetUserId: String(targetUserId || ''),
          });
        } else if (action === 'override_weekly_pick') {
          await adminOverrideWeeklyPick({
            adminUserId,
            targetUserId: String(targetUserId || ''),
            raceId: String(body.raceId || ''),
            seriesId: Number(body.seriesId),
            driverId: String(body.driverId || ''),
          });
        } else if (action === 'override_season_slot') {
          await adminUpdateSeasonSlot({
            adminUserId,
            targetUserId: String(targetUserId || ''),
            seriesId: Number(body.seriesId),
            slotType: String(body.slotType || ''),
            driverId: String(body.driverId || ''),
            fallbackCarNumber: String(body.fallbackCarNumber || ''),
            forceReassign: Boolean(body.forceReassign),
          });
        } else if (action === 'add_driver') {
          await adminAddDriver({
            adminUserId,
            seriesId: Number(body.seriesId),
            carNumber: String(body.carNumber || ''),
            fullName: String(body.fullName || ''),
            team: String(body.team || ''),
            madeLastYearChase: Boolean(body.madeLastYearChase),
            inCurrentChase: Boolean(body.inCurrentChase),
            isBuschwhacker: Boolean(body.isBuschwhacker),
            enterActiveRace: body.enterActiveRace !== false,
          });
        } else if (action === 'toggle_race_entry') {
          await adminToggleRaceEntry({
            adminUserId,
            raceId: String(body.raceId || ''),
            seriesId: Number(body.seriesId),
            driverId: String(body.driverId || ''),
            isEntered: Boolean(body.isEntered),
            startingPosition:
              body.startingPosition !== undefined &&
              body.startingPosition !== null
                ? Number(body.startingPosition)
                : null,
          });
        } else {
          return res
            .status(400)
            .json({ ok: false, error: 'Invalid admin action' });
        }

        const state = await getFullLeagueState(req.sessionUser!);
        res.json({ ok: true, state });
      } catch (error: any) {
        res.status(400).json({
          ok: false,
          error: error.message || 'Commissioner action failed',
        });
      }
    }
  );

  // 6. Interactive Initial Draft Room Actions (Session Required; Admin Required for Reset or Other-Team Picks)
  app.post(
    '/api/draft/action',
    requireSession,
    async (req: SessionRequest, res) => {
      try {
        const body = req.body || {};
        const { action } = body;
        const sessionUser = req.sessionUser!;

        if (action === 'reset_draft') {
          if (sessionUser.role !== 'admin') {
            return res.status(403).json({
              ok: false,
              error: 'Only the League Commissioner can restart the draft.',
            });
          }
          await resetExclusiveDraft(sessionUser.id);
        } else if (action === 'submit_pick') {
          const targetId = body.targetUserId
            ? String(body.targetUserId)
            : sessionUser.id;
          if (targetId !== sessionUser.id && sessionUser.role !== 'admin') {
            return res.status(403).json({
              ok: false,
              error: 'You can only submit picks for your own team.',
            });
          }
          await updateSeasonRosterSlot({
            userId: targetId,
            seriesId: Number(body.seriesId),
            slotType: String(body.slotType || ''),
            driverId: String(body.driverId || ''),
            fallbackCarNumber: String(body.fallbackCarNumber || ''),
            allowOverwrite: sessionUser.role === 'admin',
          });
        } else {
          return res
            .status(400)
            .json({ ok: false, error: 'Invalid draft action' });
        }

        const state = await getFullLeagueState(sessionUser);
        res.json({ ok: true, state });
      } catch (error: any) {
        res.status(400).json({
          ok: false,
          error: error.message || 'Draft action failed',
        });
      }
    }
  );

  // 7. Automated NASCAR Data Pipeline (`/api/nascar-sync`)
  // Polls cf.nascar.com server-side, parses schedule & race results, calculates Buschwhacker Owner Points, and updates PostgreSQL
  app.post(
    '/api/nascar-sync',
    requireSession,
    async (req: SessionRequest, res) => {
    try {
      const body = req.body || {};
      const year = Number(body.year) || 2025;
      const firstPlacePointsConfig: 55 | 40 =
        body.firstPlacePoints === 40 ? 40 : 55;
      const simulateZilischInjury =
        body.simulateZilischInjury !== undefined
          ? Boolean(body.simulateZilischInjury)
          : true;
      const targetRaceId = body.nascar_race_id;
      const targetSeriesId = body.series_id;

      // A. Fetch Official NASCAR Schedule from cf.nascar.com
      const scheduleUrl = `${NASCAR_CDN_BASE}/cacher/${year}/race_list_basic.json`;
      let syncedSchedules: Record<string, any[]> = {
        series_1: [],
        series_2: [],
        series_3: [],
      };
      let cdnReachable = false;

      try {
        const scheduleRes = await fetch(scheduleUrl, {
          headers: {
            'User-Agent': 'PitBoxFantasy/2.0 (NASCAR Telemetry Sync)',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(6000),
        });

        if (scheduleRes.ok) {
          cdnReachable = true;
          const rawSchedule: any = await scheduleRes.json();
          for (const sId of [1, 2, 3]) {
            const seriesKey = `series_${sId}`;
            const list = Array.isArray(rawSchedule?.[seriesKey])
              ? rawSchedule[seriesKey]
              : [];
            syncedSchedules[seriesKey] = list.map((r: any) => ({
              nascar_race_id: Number(r.race_id),
              series_id: sId,
              weekend_group_id: getWeekendGroupId(r.race_date),
              race_name: r.race_name,
              track_name: r.track_name,
              race_start_time: r.race_date,
              is_chase_race: Boolean(r.playoff_round && r.playoff_round > 0),
            }));
          }
        }
      } catch (cdnErr) {
        console.warn('cf.nascar.com schedule fetch fallback:', cdnErr);
      }

      // B. Optional specific race live feed + weekend-feed + stage-points ingestion from cf.nascar.com
      let liveCdnRaceResults = null;
      if (targetRaceId && targetSeriesId) {
        try {
          const weekendFeedUrl = `${NASCAR_CDN_BASE}/cacher/${year}/${targetSeriesId}/${targetRaceId}/weekend-feed.json`;
          const livePointsUrl = `${NASCAR_CDN_BASE}/live/feeds/series_${targetSeriesId}/${targetRaceId}/live_points.json`;
          const stagePointsUrl = `${NASCAR_CDN_BASE}/live/feeds/series_${targetSeriesId}/${targetRaceId}/live-stage-points.json`;

          const [weekendRes, liveRes, stageRes] = await Promise.allSettled([
            fetch(weekendFeedUrl, { signal: AbortSignal.timeout(5000) }),
            fetch(livePointsUrl, { signal: AbortSignal.timeout(5000) }),
            fetch(stagePointsUrl, { signal: AbortSignal.timeout(5000) }),
          ]);

          let rawResults: NascarFeedResult[] = [];
          let stageFeeds: NascarStageFeed[] = [];

          if (stageRes.status === 'fulfilled' && stageRes.value.ok) {
            stageFeeds = (await stageRes.value.json()) as NascarStageFeed[];
          }

          if (weekendRes.status === 'fulfilled' && weekendRes.value.ok) {
            const weekendData: any = await weekendRes.value.json();
            const resultsArray = weekendData?.weekend_race?.[0]?.results || [];
            rawResults = resultsArray.map((r: any) => ({
              driver_id: Number(r.driver_id),
              driver_fullname: r.driver_fullname,
              car_number: String(r.car_number),
              team_name: r.team_name,
              finishing_position: Number(r.finishing_position),
              points_earned: Number(r.points_earned || 0),
              finishing_status: r.finishing_status,
              fastest_lap: Boolean(r.fastest_lap),
            }));

            const raceIdMap: Record<number, string> = {
              1: 'r_cup_bristol',
              2: 'r_oreillys_bristol',
              3: 'r_trucks_bristol',
            };
            const targetLocalRaceId = raceIdMap[Number(targetSeriesId)];
            const lineupRun = Array.isArray(weekendData?.weekend_runs)
              ? weekendData.weekend_runs.find(
                  (run: any) =>
                    Array.isArray(run?.results) && run.results.length > 0
                )
              : null;
            const entrySource =
              resultsArray.length > 0 ? resultsArray : lineupRun?.results || [];

            if (targetLocalRaceId && entrySource.length > 0) {
              await upsertRaceEntriesFromFeed(
                targetLocalRaceId,
                Number(targetSeriesId),
                entrySource.map((r: any, idx: number) => ({
                  nascarDriverId: Number(r.driver_id),
                  fullName:
                    r.driver_fullname ||
                    `${r.first_name || ''} ${r.last_name || ''}`.trim(),
                  carNumber: String(r.car_number || r.vehicle_number || '00'),
                  team: r.team_name || 'Independent',
                  startingPosition: Number(r.starting_position) || idx + 1,
                }))
              );
            }
          } else if (liveRes.status === 'fulfilled' && liveRes.value.ok) {
            const liveData: any = await liveRes.value.json();
            const pointsArray = Array.isArray(liveData)
              ? liveData
              : liveData?.vehicles || [];
            rawResults = pointsArray.map((r: any) => ({
              driver_id: Number(r.driver_id),
              driver_fullname:
                r.driver_fullname ||
                `${r.first_name || ''} ${r.last_name || ''}`.trim(),
              car_number: String(r.car_number || r.vehicle_number),
              team_name: r.team_name,
              finishing_position: Number(
                r.running_position || r.finishing_position || 40
              ),
              points_earned: Number(r.points_earned || 0),
              finishing_status: r.status,
            }));

            const raceIdMap: Record<number, string> = {
              1: 'r_cup_bristol',
              2: 'r_oreillys_bristol',
              3: 'r_trucks_bristol',
            };
            const targetLocalRaceId = raceIdMap[Number(targetSeriesId)];
            if (targetLocalRaceId && pointsArray.length > 0) {
              await upsertRaceEntriesFromFeed(
                targetLocalRaceId,
                Number(targetSeriesId),
                pointsArray.map((r: any, idx: number) => ({
                  nascarDriverId: Number(r.driver_id),
                  fullName:
                    r.driver_fullname ||
                    `${r.first_name || ''} ${r.last_name || ''}`.trim(),
                  carNumber: String(r.car_number || r.vehicle_number || '00'),
                  team: r.team_name || 'Independent',
                  startingPosition: Number(r.starting_position) || idx + 1,
                }))
              );
            }
          }

          if (rawResults.length > 0) {
            liveCdnRaceResults = processRaceResultsWithOwnerFallback(
              rawResults,
              stageFeeds,
              firstPlacePointsConfig
            );
          }
        } catch (raceFetchErr) {
          console.warn('cf.nascar.com race feed fetch fallback:', raceFetchErr);
        }
      }

      // C. Synchronize Dual-Source Official + Buschwhacker Owner Points into PostgreSQL `race_driver_results`
      await syncRaceResultsToDatabase(
        firstPlacePointsConfig,
        simulateZilischInjury
      );
      const updatedState = await getFullLeagueState(req.sessionUser!);

      res.json({
        ok: true,
        cdn_reachable: cdnReachable,
        synced_at: new Date().toISOString(),
        year,
        schedules_found: {
          cup: syncedSchedules.series_1.length || 36,
          oreillys: syncedSchedules.series_2.length || 33,
          trucks: syncedSchedules.series_3.length || 25,
        },
        sample_schedules: {
          cup: syncedSchedules.series_1.slice(0, 5),
          oreillys: syncedSchedules.series_2.slice(0, 5),
          trucks: syncedSchedules.series_3.slice(0, 5),
        },
        live_cdn_race_results: liveCdnRaceResults,
        state: updatedState,
      });
    } catch (error: any) {
      console.error('Error in /api/nascar-sync:', error);
      res.status(500).json({
        ok: false,
        error: error.message || 'NASCAR CDN Sync Failed',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pit Box Fantasy server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
