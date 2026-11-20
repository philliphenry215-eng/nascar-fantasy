import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import { requireAuth, AuthRequest } from './src/middleware/auth.ts';
import {
  getOrCreateUser,
  joinLeagueMember,
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
  claimAdminWithPasscode,
} from './src/db/repository.ts';
import {
  processRaceResultsWithOwnerFallback,
  NascarFeedResult,
  NascarStageFeed,
} from './src/lib/nascar-scoring-engine.ts';

dotenv.config();

const NASCAR_CDN_BASE = 'https://cf.nascar.com';

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

  app.use(express.json());

  // 1. Fetch full PostgreSQL-backed league state
  app.get('/api/league-state', async (_req, res) => {
    try {
      const state = await getFullLeagueState();
      res.json({ ok: true, state });
    } catch (error: any) {
      console.error('Failed to fetch league state:', error);
      res.status(500).json({
        ok: false,
        error: error.message || 'Failed to load league state',
      });
    }
  });

  // 2. Authenticate & link Firebase user to PostgreSQL `users` table
  app.post('/api/auth/sync', requireAuth, async (req: AuthRequest, res) => {
    try {
      const decoded = req.user!;
      const userRecord = await getOrCreateUser(
        decoded.uid,
        decoded.email || 'driver@pitboxfantasy.com',
        decoded.name
      );
      const state = await getFullLeagueState();
      res.json({ ok: true, user: userRecord, state });
    } catch (error: any) {
      console.error('Failed to sync authenticated user:', error);
      res.status(500).json({
        ok: false,
        error: error.message || 'Failed to synchronize user profile',
      });
    }
  });

  // 2b. Sign Up / Join League via Invite Code + Team Name
  app.post('/api/league/join', async (req, res) => {
    try {
      const { name, email, avatar, inviteCode } = req.body || {};
      const newMember = await joinLeagueMember({
        name: String(name || ''),
        email: email ? String(email) : undefined,
        avatar: avatar ? String(avatar) : undefined,
        inviteCode: inviteCode ? String(inviteCode) : undefined,
      });
      const state = await getFullLeagueState();
      res.json({ ok: true, user: newMember, state });
    } catch (error: any) {
      res.status(400).json({
        ok: false,
        error: error.message || 'Failed to join league',
      });
    }
  });

  // 3. Submit or update a Weekly Pick in PostgreSQL
  app.post('/api/weekly-pick', async (req, res) => {
    try {
      const { userId, raceId, seriesId, driverId } = req.body;
      if (!userId || !raceId || !seriesId || !driverId) {
        return res.status(400).json({ ok: false, error: 'Missing pick fields' });
      }
      await saveWeeklyPick({
        userId: String(userId),
        raceId: String(raceId),
        seriesId: Number(seriesId),
        driverId: String(driverId),
      });
      const state = await getFullLeagueState();
      res.json({ ok: true, state });
    } catch (error: any) {
      res.status(400).json({
        ok: false,
        error: error.message || 'Failed to save weekly pick',
      });
    }
  });

  // 4. Update Season-Long Roster Slot or Car Anchor Fallback in PostgreSQL
  app.post('/api/season-roster', async (req, res) => {
    try {
      const { userId, seriesId, slotType, driverId, fallbackCarNumber } =
        req.body;
      if (!userId || !seriesId || !slotType || !driverId || !fallbackCarNumber) {
        return res
          .status(400)
          .json({ ok: false, error: 'Missing season roster fields' });
      }
      await updateSeasonRosterSlot({
        userId: String(userId),
        seriesId: Number(seriesId),
        slotType: String(slotType),
        driverId: String(driverId),
        fallbackCarNumber: String(fallbackCarNumber),
      });
      const state = await getFullLeagueState();
      res.json({ ok: true, state });
    } catch (error: any) {
      res.status(400).json({
        ok: false,
        error: error.message || 'Failed to update season roster',
      });
    }
  });

  // 5. Update Commissioner Admin Settings & Telemetry Simulation Toggles in PostgreSQL
  app.post('/api/admin/settings', async (req, res) => {
    try {
      const state = await updateLeagueAdminSettings(req.body || {});
      res.json({ ok: true, state });
    } catch (error: any) {
      console.error('Failed to update commissioner settings:', error);
      res.status(500).json({
        ok: false,
        error: error.message || 'Failed to update commissioner settings',
      });
    }
  });

  // 5b. Commissioner Team Management (Adjust any team's profile, role, points, weekly pick, or season roster/anchor)
  app.post('/api/admin/team', async (req, res) => {
    try {
      const body = req.body || {};
      const { action, adminUserId, targetUserId } = body;

      if (action === 'claim_admin') {
        await claimAdminWithPasscode({
          targetUserId: String(targetUserId || ''),
          passcode: String(body.passcode || ''),
        });
      } else if (action === 'update_profile') {
        await adminUpdateTeam({
          adminUserId: String(adminUserId || ''),
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
          adminUserId: String(adminUserId || ''),
          targetUserId: String(targetUserId || ''),
        });
      } else if (action === 'override_weekly_pick') {
        await adminOverrideWeeklyPick({
          adminUserId: String(adminUserId || ''),
          targetUserId: String(targetUserId || ''),
          raceId: String(body.raceId || ''),
          seriesId: Number(body.seriesId),
          driverId: String(body.driverId || ''),
        });
      } else if (action === 'override_season_slot') {
        await adminUpdateSeasonSlot({
          adminUserId: String(adminUserId || ''),
          targetUserId: String(targetUserId || ''),
          seriesId: Number(body.seriesId),
          slotType: String(body.slotType || ''),
          driverId: String(body.driverId || ''),
          fallbackCarNumber: String(body.fallbackCarNumber || ''),
          forceReassign: Boolean(body.forceReassign),
        });
      } else {
        return res.status(400).json({ ok: false, error: 'Invalid admin action' });
      }

      const state = await getFullLeagueState();
      res.json({ ok: true, state });
    } catch (error: any) {
      res.status(400).json({
        ok: false,
        error: error.message || 'Commissioner action failed',
      });
    }
  });

  // 5c. Interactive Initial Draft Room Actions (Reset Draft / Submit Pick)
  app.post('/api/draft/action', async (req, res) => {
    try {
      const body = req.body || {};
      const { action } = body;

      if (action === 'reset_draft') {
        await resetExclusiveDraft(String(body.adminUserId || ''));
      } else if (action === 'submit_pick') {
        await updateSeasonRosterSlot({
          userId: String(body.targetUserId || ''),
          seriesId: Number(body.seriesId),
          slotType: String(body.slotType || ''),
          driverId: String(body.driverId || ''),
          fallbackCarNumber: String(body.fallbackCarNumber || ''),
        });
      } else {
        return res.status(400).json({ ok: false, error: 'Invalid draft action' });
      }

      const state = await getFullLeagueState();
      res.json({ ok: true, state });
    } catch (error: any) {
      res.status(400).json({
        ok: false,
        error: error.message || 'Draft action failed',
      });
    }
  });

  // 6. Automated NASCAR Data Pipeline (`/api/nascar-sync`)
  // Polls cf.nascar.com server-side, parses schedule & race results, calculates Buschwhacker Owner Points, and updates PostgreSQL
  app.post('/api/nascar-sync', async (req, res) => {
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
      const updatedState = await getFullLeagueState();

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
