import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Trophy,
  Calendar,
  Database,
  Users,
  RefreshCw,
  Lock,
  Unlock,
  Sliders,
  ArrowUpDown,
  LogIn,
  LogOut,
  Check,
  AlertCircle,
  UserPlus,
  ChevronDown,
  ChevronUp,
  Copy,
  X,
  ArrowLeftRight,
  ShieldCheck,
  Crown,
  Trash2,
  RotateCcw,
  Shuffle,
  Play,
} from 'lucide-react';
import {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import { auth, googleAuthProvider } from './lib/firebase.ts';
import {
  resolveSeasonSlotScore,
  ComputedRaceResult,
} from './lib/nascar-scoring-engine.ts';

type SeriesId = 1 | 2 | 3;

interface SeriesMeta {
  id: SeriesId;
  name: string;
  shortName: string;
  slotCode: string;
  colorHex: string;
  pillBg: string;
  pylonBg: string;
  maxWeeklyUses: number;
}

// Authentic NASCAR 3-Bar Brand Palette:
// Sunburst Yellow (#FFD100) for Cup, Racing Red (#E4002B) for O'Reilly's, Cobalt Blue (#1D63FF) for Trucks
const SERIES_META: Record<SeriesId, SeriesMeta> = {
  1: {
    id: 1,
    name: 'NASCAR Cup Series',
    shortName: 'Cup',
    slotCode: 'CUP',
    colorHex: '#FFD100',
    pillBg: 'bg-[#FFD100]/15 text-[#FFD100] border-[#FFD100]/40',
    pylonBg: 'bg-[#FFD100] text-black',
    maxWeeklyUses: 5,
  },
  2: {
    id: 2,
    name: "NASCAR O'Reilly's Series",
    shortName: "O'Reilly's",
    slotCode: 'ORL',
    colorHex: '#E4002B',
    pillBg: 'bg-[#E4002B]/15 text-[#FF4D6D] border-[#E4002B]/40',
    pylonBg: 'bg-[#E4002B] text-white',
    maxWeeklyUses: 5,
  },
  3: {
    id: 3,
    name: 'NASCAR Craftsman Truck Series',
    shortName: 'Trucks',
    slotCode: 'TRK',
    colorHex: '#1D63FF',
    pillBg: 'bg-[#1D63FF]/15 text-[#609BFF] border-[#1D63FF]/40',
    pylonBg: 'bg-[#1D63FF] text-white',
    maxWeeklyUses: 5,
  },
};

interface DbUser {
  id: string;
  uid: string;
  email: string;
  name: string;
  avatar: string;
  lastYearRank: number;
  role: string;
  cumulativePriorPoints: number;
}

interface DbSeriesConfig {
  id: number;
  name: string;
  shortName: string;
  badgeColor: string;
  maxWeeklyUsesPerDriver: number;
  chaseActive: boolean;
  firstPlacePoints: number;
  useCarAnchorFallback: boolean;
}

interface DbDriver {
  id: string;
  nascarDriverId: number;
  seriesId: number;
  carNumber: string;
  fullName: string;
  team: string;
  madeLastYearChase: boolean;
  inCurrentChase: boolean;
  isBuschwhacker: boolean;
  active: boolean;
}

interface DbRace {
  id: string;
  nascarRaceId: number;
  seriesId: number;
  weekendGroupId: string;
  raceName: string;
  trackName: string;
  raceStartTime: string;
  isChaseRace: boolean;
  isLockedRevealed: boolean;
  isActiveWeekend: boolean;
  syncStatus: string;
  lastSyncedAt: string | null;
}

interface DbSeasonRoster {
  id: number;
  userId: string;
  seriesId: number;
  slotType: string;
  driverId: string;
  fallbackCarNumber: string;
}

interface DbWeeklyPick {
  id: number;
  userId: string;
  raceId: string;
  seriesId: number;
  driverId: string;
  trackLabel: string | null;
  isHistorical: boolean;
  submittedAt: string;
}

interface DbRaceResult {
  id: number;
  raceId: string;
  driverId: string | null;
  nascarDriverId: number;
  driverFullname: string;
  actualCarNumber: string;
  actualTeamName: string;
  finishPosition: number;
  stagePoints: number;
  fastestLapBonus: number;
  driverPoints: number;
  calculatedOwnerPoints: number;
  effectiveFantasyPoints: number;
  scoringSource:
    | 'OFFICIAL_DRIVER_PTS'
    | 'BUSCHWHACKER_OWNER_PTS'
    | 'DQ_PENALTY';
  isDisqualified: boolean;
}

interface LeagueStatePayload {
  users: DbUser[];
  seriesConfig: DbSeriesConfig[];
  drivers: DbDriver[];
  races: DbRace[];
  seasonRosters: DbSeasonRoster[];
  weeklyPicks: DbWeeklyPick[];
  raceDriverResults: DbRaceResult[];
}

const EXTRA_USAGE_HISTORY: Record<string, string[]> = {
  c3: ['Martinsville'],
  cn1: ['Talladega', 'Dover'],
  o_bw1: ['Darlington'],
  o1: ['Watkins Glen', 'Road America'],
  t2: ['Bristol Spring', 'Martinsville', 'North Wilkesboro', 'Charlotte'],
  t_bw1: ['Atlanta', 'Las Vegas'],
};

export default function App() {
  const [activeTab, setActiveTab] = useState<
    'picks' | 'standings' | 'bank' | 'draft' | 'admin'
  >('picks');

  // Firebase Auth & Active Manager Switcher
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const idTokenRef = useRef<string | null>(null);
  const [activeManagerId, setActiveManagerId] = useState<string>('u1');

  // League State from PostgreSQL Backend
  const [leagueState, setLeagueState] = useState<LeagueStatePayload | null>(
    null
  );
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [statusBanner, setStatusBanner] = useState<{
    type: 'info' | 'error' | 'success';
    text: string;
  } | null>(null);

  // Sleeper-style Bottom Sheet / Drawer States
  const [swapWeeklyDrawerSeries, setSwapWeeklyDrawerSeries] =
    useState<SeriesId | null>(null);
  const [swapSeasonDrawerSlot, setSwapSeasonDrawerSlot] = useState<{
    slotType: string;
    label: string;
    seriesId: SeriesId;
    exclusive: boolean;
  } | null>(null);
  const [showJoinModal, setShowJoinModal] = useState<boolean>(false);
  const [newTeamName, setNewTeamName] = useState<string>('');
  const [newTeamEmail, setNewTeamEmail] = useState<string>('');
  const [inviteCodeInput, setInviteCodeInput] =
    useState<string>('PITBOX-2026');
  const [isJoining, setIsJoining] = useState<boolean>(false);
  const [copiedInvite, setCopiedInvite] = useState<boolean>(false);

  // Expanded cards in Standings / League Board
  const [expandedMemberIds, setExpandedMemberIds] = useState<
    Record<string, boolean>
  >({ u1: true, u2: true });

  // Sync & Simulation State
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string>('Live');
  const [simulateZilischInjury, setSimulateZilischInjury] =
    useState<boolean>(true);
  const [cdnSchedulesSummary, setCdnSchedulesSummary] = useState<{
    cup: number;
    oreillys: number;
    trucks: number;
  }>({ cup: 36, oreillys: 33, trucks: 25 });

  // Filters & Draft Room State
  const [bankSeriesFilter, setBankSeriesFilter] = useState<SeriesId>(1);
  const [standingsViewFilter, setStandingsViewFilter] = useState<
    'all' | 'weekly_only' | 'season_only'
  >('all');
  const [draftOrderMode, setDraftOrderMode] = useState<
    'reverse_standings' | 'random'
  >('reverse_standings');
  const [draftFormat, setDraftFormat] = useState<'snake' | 'linear'>('snake');
  const [randomOrderIds, setRandomOrderIds] = useState<string[]>([]);
  const [selectedDraftSlotType, setSelectedDraftSlotType] = useState<
    'cup_prev_chase' | 'cup_prev_non_chase' | 'oreillys_season' | 'trucks_season'
  >('cup_prev_chase');

  // Commissioner Team Control State
  const [adminTargetUserId, setAdminTargetUserId] = useState<string>('u1');
  const [adminEditName, setAdminEditName] = useState<string>('');
  const [adminEditRank, setAdminEditRank] = useState<number>(1);
  const [adminEditPriorPts, setAdminEditPriorPts] = useState<number>(2400);
  const [adminForceReassign, setAdminForceReassign] = useState<boolean>(true);
  const [adminPasscode, setAdminPasscode] = useState<string>('');
  const [adminAnchorDrafts, setAdminAnchorDrafts] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    let mounted = true;
    async function loadInitial() {
      try {
        const res = await fetch('/api/league-state');
        const data = await res.json();
        if (mounted && data.ok && data.state) {
          setLeagueState(data.state);
          const oreillysResults: DbRaceResult[] =
            data.state.raceDriverResults || [];
          const zilischPresent = oreillysResults.some(
            (r) =>
              r.raceId === 'r_oreillys_bristol' && r.nascarDriverId === 5001
          );
          setSimulateZilischInjury(!zilischPresent);
        }
      } catch (err) {
        console.error('Failed to load initial state:', err);
      } finally {
        if (mounted) setIsLoading(false);
      }
    }
    loadInitial();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (user) {
        try {
          const token = await user.getIdToken();
          idTokenRef.current = token;
          const res = await fetch('/api/auth/sync', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
          });
          const data = await res.json();
          if (data.ok && data.state) {
            setLeagueState(data.state);
            if (data.user?.id) {
              setActiveManagerId(data.user.id);
            }
          }
        } catch (err) {
          console.error('Auth sync error:', err);
        }
      } else {
        idTokenRef.current = null;
      }
    });
    return () => unsubscribe();
  }, []);

  const handleGoogleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleAuthProvider);
      setShowJoinModal(false);
      setStatusBanner({
        type: 'success',
        text: 'Signed in with Google and linked to your team!',
      });
    } catch (error: any) {
      setStatusBanner({
        type: 'error',
        text: error?.message || 'Sign-in cancelled.',
      });
    }
  };

  const handleJoinLeagueSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTeamName.trim()) return;
    setIsJoining(true);
    try {
      const res = await fetch('/api/league/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newTeamName.trim(),
          email: newTeamEmail.trim() || undefined,
          inviteCode: inviteCodeInput.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok && data.state && data.user) {
        setLeagueState(data.state);
        setActiveManagerId(data.user.id);
        setNewTeamName('');
        setNewTeamEmail('');
        setShowJoinModal(false);
        setStatusBanner({
          type: 'success',
          text: `Welcome ${data.user.name}! Your team and starter lineup are now active.`,
        });
      } else {
        setStatusBanner({
          type: 'error',
          text: data.error || 'Could not join league.',
        });
      }
    } catch (err: any) {
      setStatusBanner({
        type: 'error',
        text: err?.message || 'Failed to join league.',
      });
    } finally {
      setIsJoining(false);
    }
  };

  const handleCopyInvite = () => {
    navigator.clipboard?.writeText('PITBOX-2026').catch(() => {});
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 2000);
  };

  const cupConfig = useMemo(
    () => leagueState?.seriesConfig.find((s) => s.id === 1),
    [leagueState]
  );
  const firstPlacePoints: 55 | 40 =
    cupConfig?.firstPlacePoints === 40 ? 40 : 55;
  const useCarAnchorFallback: boolean =
    cupConfig?.useCarAnchorFallback ?? true;
  const midSeasonChaseActive: boolean = cupConfig?.chaseActive ?? true;

  const weekendRacesBySeries = useMemo(() => {
    const map: Record<SeriesId, DbRace | undefined> = {
      1: undefined,
      2: undefined,
      3: undefined,
    };
    for (const r of leagueState?.races || []) {
      if (r.id === 'r_cup_bristol') map[1] = r;
      if (r.id === 'r_oreillys_bristol') map[2] = r;
      if (r.id === 'r_trucks_bristol') map[3] = r;
    }
    return map;
  }, [leagueState]);

  const computedWeekendResults = useMemo(() => {
    const grouped: Record<SeriesId, ComputedRaceResult[]> = {
      1: [],
      2: [],
      3: [],
    };
    const raceToSeries: Record<string, SeriesId> = {
      r_cup_bristol: 1,
      r_oreillys_bristol: 2,
      r_trucks_bristol: 3,
    };

    for (const row of leagueState?.raceDriverResults || []) {
      const sId = raceToSeries[row.raceId];
      if (sId) {
        grouped[sId].push({
          nascar_driver_id: row.nascarDriverId,
          driver_fullname: row.driverFullname,
          actual_car_number: row.actualCarNumber,
          actual_team_name: row.actualTeamName,
          finish_position: row.finishPosition,
          stage_points: row.stagePoints,
          fastest_lap_bonus: row.fastestLapBonus,
          driver_points: row.driverPoints,
          calculated_owner_points: row.calculatedOwnerPoints,
          effective_fantasy_points: row.effectiveFantasyPoints,
          is_disqualified: row.isDisqualified,
          scoring_source: row.scoringSource,
        });
      }
    }
    grouped[1].sort((a, b) => a.finish_position - b.finish_position);
    grouped[2].sort((a, b) => a.finish_position - b.finish_position);
    grouped[3].sort((a, b) => a.finish_position - b.finish_position);
    return grouped;
  }, [leagueState]);

  const getDriverRemainingUses = (driverId: string, seriesId: SeriesId) => {
    const dbHistorical = (leagueState?.weeklyPicks || [])
      .filter(
        (p) =>
          p.userId === activeManagerId &&
          p.driverId === driverId &&
          p.isHistorical
      )
      .map((p) => p.trackLabel || 'Prior Race');

    const extraTracks = EXTRA_USAGE_HISTORY[driverId] || [];
    const combinedTracks =
      dbHistorical.length > 0 ? dbHistorical : extraTracks;

    const seriesCfg = leagueState?.seriesConfig.find((s) => s.id === seriesId);
    const maxUses = seriesCfg?.maxWeeklyUsesPerDriver ?? 5;

    const activeRaceId = weekendRacesBySeries[seriesId]?.id;
    const isCurrentlyPicked = (leagueState?.weeklyPicks || []).some(
      (p) =>
        p.userId === activeManagerId &&
        p.raceId === activeRaceId &&
        p.driverId === driverId &&
        !p.isHistorical
    );

    return {
      pastTracks: combinedTracks,
      used: combinedTracks.length,
      isCurrentlyPicked,
      remaining: Math.max(0, maxUses - combinedTracks.length),
      maxUses,
    };
  };

  // Automatic Points Distribution & Standings Math
  const leaderboard = useMemo(() => {
    if (!leagueState) return [];
    const allDrivers = leagueState.drivers;
    const allRosters = leagueState.seasonRosters;
    const allPicks = leagueState.weeklyPicks;

    return leagueState.users
      .map((member) => {
        const getDriverObj = (dId: string) =>
          allDrivers.find((d) => d.id === dId);

        const calcWeeklyPick = (seriesId: SeriesId) => {
          const raceObj = weekendRacesBySeries[seriesId];
          if (!raceObj || !raceObj.isActiveWeekend) {
            return {
              points: 0,
              driverName: 'Series Off-Week',
              teamName: 'No Race Scheduled',
              isOwnerPts: false,
              carNumber: '-',
              driverId: '',
              finishPos: null as number | null,
            };
          }

          const pickRow = allPicks.find(
            (p) =>
              p.userId === member.id &&
              p.raceId === raceObj.id &&
              !p.isHistorical
          );
          const driverObj = pickRow ? getDriverObj(pickRow.driverId) : undefined;
          if (!driverObj) {
            return {
              points: 0,
              driverName: 'Empty Slot',
              teamName: 'Tap Swap to Pick',
              isOwnerPts: false,
              carNumber: '-',
              driverId: '',
              finishPos: null as number | null,
            };
          }

          const result = computedWeekendResults[seriesId].find(
            (r) => r.nascar_driver_id === driverObj.nascarDriverId
          );

          if (!result) {
            return {
              points: 0,
              driverName: driverObj.fullName,
              teamName: driverObj.team,
              isOwnerPts: false,
              carNumber: driverObj.carNumber,
              driverId: driverObj.id,
              finishPos: null as number | null,
            };
          }

          const isOwnerPts =
            result.scoring_source === 'BUSCHWHACKER_OWNER_PTS';
          return {
            points: result.effective_fantasy_points,
            driverName: result.driver_fullname,
            teamName: result.actual_team_name,
            isOwnerPts,
            carNumber: result.actual_car_number,
            driverId: driverObj.id,
            finishPos: result.finish_position,
          };
        };

        const calcSeasonSlot = (seriesId: SeriesId, slotType: string) => {
          const raceObj = weekendRacesBySeries[seriesId];
          const slotRow = allRosters.find(
            (r) => r.userId === member.id && r.slotType === slotType
          );
          const driverObj = slotRow
            ? getDriverObj(slotRow.driverId)
            : undefined;

          if (!raceObj || !raceObj.isActiveWeekend) {
            return {
              points: 0,
              badgeText: 'Series Off-Week',
              driverName: driverObj?.fullName || 'Off-Week',
              teamName: driverObj?.team || '',
              usedCarAnchor: false,
              actualCarNumber: slotRow?.fallbackCarNumber || '-',
              slotRow,
            };
          }
          if (!slotRow || !driverObj) {
            return {
              points: 0,
              badgeText: 'Unassigned',
              driverName: 'Unassigned',
              teamName: 'Tap to Draft',
              usedCarAnchor: false,
              actualCarNumber: '-',
              slotRow,
            };
          }

          const resolved = resolveSeasonSlotScore({
            primaryNascarDriverId: driverObj.nascarDriverId,
            fallbackCarNumber: slotRow.fallbackCarNumber,
            useCarAnchorFallback,
            raceResults: computedWeekendResults[seriesId],
          });

          return {
            ...resolved,
            driverName: resolved.usedCarAnchor
              ? `Car Anchor #${slotRow.fallbackCarNumber} (Sub Active)`
              : driverObj.fullName,
            teamName: resolved.usedCarAnchor
              ? `Drafted: ${driverObj.fullName} (DNS)`
              : driverObj.team,
            slotRow,
          };
        };

        const cupWeekly = calcWeeklyPick(1);
        const cupSeasonChase = calcSeasonSlot(1, 'cup_prev_chase');
        const cupSeasonNonChase = calcSeasonSlot(1, 'cup_prev_non_chase');
        const cupMidSeasonBonus = midSeasonChaseActive
          ? calcSeasonSlot(1, 'cup_current_chase')
          : {
              points: 0,
              badgeText: 'Unlocks at Chase (Last 10 Races)',
              driverName: 'Locked Until Chase',
              teamName: 'Final 10 Cup Races',
              usedCarAnchor: false,
              actualCarNumber: '-',
              slotRow: undefined,
            };

        const cupTotal =
          cupWeekly.points +
          cupSeasonChase.points +
          cupSeasonNonChase.points +
          cupMidSeasonBonus.points;

        const oreillysWeekly = calcWeeklyPick(2);
        const oreillysSeason = calcSeasonSlot(2, 'oreillys_season');
        const oreillysTotal = oreillysWeekly.points + oreillysSeason.points;

        const trucksWeekly = calcWeeklyPick(3);
        const trucksSeason = calcSeasonSlot(3, 'trucks_season');
        const trucksTotal = trucksWeekly.points + trucksSeason.points;

        const weeklyOnlyWeekendTotal =
          cupWeekly.points + oreillysWeekly.points + trucksWeekly.points;
        const seasonOnlyWeekendTotal =
          cupSeasonChase.points +
          cupSeasonNonChase.points +
          cupMidSeasonBonus.points +
          oreillysSeason.points +
          trucksSeason.points;

        const weekendTotal = cupTotal + oreillysTotal + trucksTotal;
        const grandTotal = member.cumulativePriorPoints + weekendTotal;

        return {
          ...member,
          breakdown: {
            cupWeekly,
            cupSeasonChase,
            cupSeasonNonChase,
            cupMidSeasonBonus,
            cupTotal,
            oreillysWeekly,
            oreillysSeason,
            oreillysTotal,
            trucksWeekly,
            trucksSeason,
            trucksTotal,
            weeklyOnlyWeekendTotal,
            seasonOnlyWeekendTotal,
            weekendTotal,
            grandTotal,
          },
        };
      })
      .sort((a, b) => {
        if (standingsViewFilter === 'weekly_only') {
          return (
            b.breakdown.weeklyOnlyWeekendTotal -
            a.breakdown.weeklyOnlyWeekendTotal
          );
        }
        if (standingsViewFilter === 'season_only') {
          return (
            b.breakdown.seasonOnlyWeekendTotal -
            a.breakdown.seasonOnlyWeekendTotal
          );
        }
        return b.breakdown.grandTotal - a.breakdown.grandTotal;
      });
  }, [
    leagueState,
    weekendRacesBySeries,
    computedWeekendResults,
    useCarAnchorFallback,
    midSeasonChaseActive,
    standingsViewFilter,
  ]);

  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
      const res = await fetch('/api/nascar-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year: 2025,
          firstPlacePoints,
          simulateZilischInjury,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        if (data.state) setLeagueState(data.state);
        if (data.schedules_found) setCdnSchedulesSummary(data.schedules_found);
        const nowStr = new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        setLastSyncedAt(nowStr);
        setStatusBanner({
          type: 'success',
          text: `Synced cf.nascar.com feeds & recalculated Owner Points (${nowStr}).`,
        });
      }
    } catch (error: any) {
      setStatusBanner({
        type: 'error',
        text: error?.message || 'Failed to sync NASCAR feed.',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSelectWeeklyPick = async (
    seriesId: SeriesId,
    driverId: string
  ) => {
    const raceObj = weekendRacesBySeries[seriesId];
    if (!raceObj) return;
    try {
      const res = await fetch('/api/weekly-pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: activeManagerId,
          raceId: raceObj.id,
          seriesId,
          driverId,
        }),
      });
      const data = await res.json();
      if (data.ok && data.state) {
        setLeagueState(data.state);
        setSwapWeeklyDrawerSeries(null);
        setStatusBanner({
          type: 'success',
          text: `${SERIES_META[seriesId].shortName} weekly starter locked in!`,
        });
      } else {
        setStatusBanner({
          type: 'error',
          text: data.error || 'Could not save weekly pick.',
        });
      }
    } catch (error: any) {
      setStatusBanner({
        type: 'error',
        text: error?.message || 'Could not save weekly pick.',
      });
    }
  };

  const handleUpdateAdminSetting = async (patch: {
    firstPlacePoints?: 55 | 40;
    useCarAnchorFallback?: boolean;
    chaseActive?: boolean;
    simulateZilischInjury?: boolean;
    raceLocks?: Record<number, boolean>;
    activeSeriesWeekend?: Record<number, boolean>;
  }) => {
    if (patch.simulateZilischInjury !== undefined) {
      setSimulateZilischInjury(patch.simulateZilischInjury);
    }
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstPlacePoints,
          useCarAnchorFallback,
          chaseActive: midSeasonChaseActive,
          simulateZilischInjury,
          ...patch,
        }),
      });
      const data = await res.json();
      if (data.ok && data.state) {
        setLeagueState(data.state);
      }
    } catch (err) {
      console.error('Failed to update setting:', err);
    }
  };

  const handleUpdateSeasonSlot = async (
    seriesId: number,
    slotType: string,
    driverId: string,
    fallbackCarNumber: string
  ) => {
    try {
      const res = await fetch('/api/season-roster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: activeManagerId,
          seriesId,
          slotType,
          driverId,
          fallbackCarNumber,
        }),
      });
      const data = await res.json();
      if (data.ok && data.state) {
        setLeagueState(data.state);
        setSwapSeasonDrawerSlot(null);
        setStatusBanner({
          type: 'success',
          text: 'Season roster slot and Car Anchor updated!',
        });
      } else {
        setStatusBanner({
          type: 'error',
          text: data.error || 'Driver is already locked by another manager.',
        });
      }
    } catch (err: any) {
      setStatusBanner({
        type: 'error',
        text: err?.message || 'Failed to update season roster.',
      });
    }
  };

  const sortedDraftOrder = useMemo(() => {
    const list = [...(leagueState?.users || [])];
    if (draftOrderMode === 'reverse_standings') {
      return list.sort((a, b) => b.lastYearRank - a.lastYearRank);
    }
    if (randomOrderIds.length > 0) {
      const byId = new Map(list.map((u) => [u.id, u]));
      const ordered = randomOrderIds
        .map((id) => byId.get(id))
        .filter(Boolean) as DbUser[];
      const missing = list.filter((u) => !randomOrderIds.includes(u.id));
      return [...ordered, ...missing];
    }
    return [...list].reverse();
  }, [leagueState, draftOrderMode, randomOrderIds]);

  const handleShuffleDraftOrder = () => {
    const ids = (leagueState?.users || []).map((u) => u.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    setRandomOrderIds(ids);
    setDraftOrderMode('random');
  };

  // Compute 4-round Exclusive Pre-Season Draft Queue & who is On The Clock
  const draftProgress = useMemo(() => {
    const order = sortedDraftOrder;
    const exclusiveSlots = [
      'cup_prev_chase',
      'cup_prev_non_chase',
      'oreillys_season',
      'trucks_season',
    ] as const;

    const rosters = leagueState?.seasonRosters || [];
    const filledCountByUser = new Map<string, number>();
    for (const u of order) {
      const count = rosters.filter(
        (r) =>
          r.userId === u.id &&
          r.slotType !== 'cup_current_chase'
      ).length;
      filledCountByUser.set(u.id, count);
    }

    const queue: Array<{
      overall: number;
      round: number;
      pickInRound: number;
      label: string;
      user: DbUser;
      isFilled: boolean;
    }> = [];

    const occurrenceByUser = new Map<string, number>();
    let overall = 1;

    for (let round = 1; round <= 4; round++) {
      const roundUsers =
        draftFormat === 'snake' && round % 2 === 0
          ? [...order].reverse()
          : order;

      roundUsers.forEach((u, idx) => {
        const occ = (occurrenceByUser.get(u.id) || 0) + 1;
        occurrenceByUser.set(u.id, occ);
        const filledCount = filledCountByUser.get(u.id) || 0;
        queue.push({
          overall: overall++,
          round,
          pickInRound: idx + 1,
          label: `${round}.${String(idx + 1).padStart(2, '0')}`,
          user: u,
          isFilled: filledCount >= occ,
        });
      });
    }

    const onTheClock = queue.find((q) => !q.isFilled) || null;
    const totalNeeded = order.length * exclusiveSlots.length;
    const totalDrafted = queue.filter((q) => q.isFilled).length;

    const openSlotsForOnClock = onTheClock
      ? exclusiveSlots.filter(
          (st) =>
            !rosters.some(
              (r) => r.userId === onTheClock.user.id && r.slotType === st
            )
        )
      : [];

    return {
      queue,
      onTheClock,
      totalNeeded,
      totalDrafted,
      isComplete: order.length > 0 && totalDrafted >= totalNeeded,
      openSlotsForOnClock,
    };
  }, [sortedDraftOrder, leagueState, draftFormat]);

  // Keep selectedDraftSlotType valid for the manager currently On The Clock
  useEffect(() => {
    if (
      draftProgress.openSlotsForOnClock.length > 0 &&
      !draftProgress.openSlotsForOnClock.includes(selectedDraftSlotType)
    ) {
      setSelectedDraftSlotType(draftProgress.openSlotsForOnClock[0]);
    }
  }, [draftProgress.openSlotsForOnClock, selectedDraftSlotType]);

  // Sync Commissioner Team Editor inputs when target team changes
  useEffect(() => {
    const target = (leagueState?.users || []).find(
      (u) => u.id === adminTargetUserId
    );
    if (target) {
      setAdminEditName(target.name);
      setAdminEditRank(target.lastYearRank);
      setAdminEditPriorPts(target.cumulativePriorPoints);
      const anchorMap: Record<string, string> = {};
      for (const r of leagueState?.seasonRosters || []) {
        if (r.userId === target.id) {
          anchorMap[r.slotType] = r.fallbackCarNumber;
        }
      }
      setAdminAnchorDrafts(anchorMap);
    } else if ((leagueState?.users || []).length > 0) {
      setAdminTargetUserId(leagueState!.users[0].id);
    }
  }, [adminTargetUserId, leagueState]);

  const handleAdminTeamAction = async (
    payload: Record<string, any>,
    successMsg: string
  ) => {
    try {
      const res = await fetch('/api/admin/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminUserId: activeManagerId,
          ...payload,
        }),
      });
      const data = await res.json();
      if (data.ok && data.state) {
        setLeagueState(data.state);
        setStatusBanner({ type: 'success', text: successMsg });
      } else {
        setStatusBanner({
          type: 'error',
          text: data.error || 'Commissioner action failed.',
        });
      }
    } catch (err: any) {
      setStatusBanner({
        type: 'error',
        text: err?.message || 'Commissioner action failed.',
      });
    }
  };

  const handleDraftAction = async (
    payload: Record<string, any>,
    successMsg: string
  ) => {
    try {
      const res = await fetch('/api/draft/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminUserId: activeManagerId,
          ...payload,
        }),
      });
      const data = await res.json();
      if (data.ok && data.state) {
        setLeagueState(data.state);
        setStatusBanner({ type: 'success', text: successMsg });
      } else {
        setStatusBanner({
          type: 'error',
          text: data.error || 'Draft action failed.',
        });
      }
    } catch (err: any) {
      setStatusBanner({
        type: 'error',
        text: err?.message || 'Draft action failed.',
      });
    }
  };

  const handleAutoPickForClock = async () => {
    if (!draftProgress.onTheClock) return;
    const slotType = selectedDraftSlotType;
    const slotMetaMap: Record<
      typeof slotType,
      { seriesId: number; filter: (d: DbDriver) => boolean }
    > = {
      cup_prev_chase: { seriesId: 1, filter: (d) => d.madeLastYearChase },
      cup_prev_non_chase: { seriesId: 1, filter: (d) => !d.madeLastYearChase },
      oreillys_season: { seriesId: 2, filter: () => true },
      trucks_season: { seriesId: 3, filter: () => true },
    };
    const cfg = slotMetaMap[slotType];
    const takenIds = new Set(
      (leagueState?.seasonRosters || [])
        .filter((r) => r.slotType !== 'cup_current_chase')
        .map((r) => r.driverId)
    );
    const bestAvailable = (leagueState?.drivers || []).find(
      (d) =>
        d.seriesId === cfg.seriesId &&
        !d.isBuschwhacker &&
        !takenIds.has(d.id) &&
        cfg.filter(d)
    );
    if (!bestAvailable) {
      setStatusBanner({
        type: 'error',
        text: 'No undrafted drivers remain in this category.',
      });
      return;
    }
    await handleDraftAction(
      {
        action: 'submit_pick',
        targetUserId: draftProgress.onTheClock.user.id,
        seriesId: cfg.seriesId,
        slotType,
        driverId: bestAvailable.id,
        fallbackCarNumber: bestAvailable.carNumber,
      },
      `${draftProgress.onTheClock.user.name} drafted #${bestAvailable.carNumber} ${bestAvailable.fullName} (${draftProgress.onTheClock.label})!`
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#090A0F] text-white flex items-center justify-center p-4">
        <div className="max-w-sm w-full bg-[#131620] border border-slate-800 rounded-2xl p-4 space-y-3">
          <div className="h-5 w-40 bg-slate-800 rounded animate-pulse" />
          <div className="h-14 w-full bg-slate-800/60 rounded-xl animate-pulse" />
          <div className="h-14 w-full bg-slate-800/60 rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  const activeUserRow =
    leaderboard.find((u) => u.id === activeManagerId) || leaderboard[0];
  const activeRank =
    leaderboard.findIndex((u) => u.id === activeUserRow?.id) + 1;
  const isCurrentUserAdmin = activeUserRow?.role === 'admin';
  const primaryAdmin =
    (leagueState?.users || []).find((u) => u.role === 'admin') ||
    leagueState?.users?.[0];

  return (
    <div className="min-h-screen bg-[#090A0F] text-white flex flex-col md:flex-row selection:bg-[#FFD100] selection:text-black">
      {/* ==========================================
          DESKTOP SIDEBAR (Sleeper-style Dark Rail)
      ========================================== */}
      <aside className="hidden md:flex md:w-60 md:flex-col md:fixed md:inset-y-0 bg-[#10131C] border-r border-slate-800/80 z-30">
        {/* Iconic NASCAR 3-Color Telemetry Bar */}
        <div className="h-1.5 w-full flex">
          <div className="flex-1 bg-[#FFD100]" />
          <div className="flex-1 bg-[#E4002B]" />
          <div className="flex-1 bg-[#1D63FF]" />
        </div>

        <div className="px-4 py-3.5 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center -space-x-1">
              <span className="w-2 h-5 bg-[#FFD100] skew-x-[-14deg] rounded-xs" />
              <span className="w-2 h-5 bg-[#E4002B] skew-x-[-14deg] rounded-xs" />
              <span className="w-2 h-5 bg-[#1D63FF] skew-x-[-14deg] rounded-xs" />
            </div>
            <span className="font-display font-bold tracking-wider text-xl text-white">
              PIT BOX
            </span>
          </div>
          <span className="font-mono text-[11px] text-slate-400">
            {leagueState?.users.length || 6}-TEAM
          </span>
        </div>

        {/* Active Team Switcher / Sign Up */}
        <div className="p-3 border-b border-slate-800/80 space-y-2 bg-[#141824]">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>VIEWING TEAM AS</span>
            <button
              onClick={() => setShowJoinModal(true)}
              className="text-[#FFD100] hover:underline font-semibold flex items-center gap-1 cursor-pointer"
            >
              <UserPlus className="w-3 h-3" /> + Join / Sign Up
            </button>
          </div>
          <select
            value={activeManagerId}
            onChange={(e) => setActiveManagerId(e.target.value)}
            className="w-full min-h-[38px] bg-[#090A0F] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white"
          >
            {(leagueState?.users || []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} {u.role === 'admin' ? '(Commish)' : ''}
              </option>
            ))}
          </select>
        </div>

        <nav className="flex-1 p-2.5 space-y-1">
          {[
            { id: 'picks', label: 'My Lineup & Picks', icon: Calendar },
            { id: 'standings', label: 'League Scoreboard', icon: Trophy },
            { id: 'bank', label: 'Driver Usage Bank', icon: Database },
            { id: 'draft', label: 'Draft & Season Roster', icon: Users },
            { id: 'admin', label: 'Commish & League Hub', icon: Sliders },
          ].map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id as any)}
                className={`w-full min-h-[42px] flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-[#1D2233] text-[#FFD100] border border-slate-700'
                    : 'text-slate-400 hover:bg-[#161A26] hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-3 m-2.5 rounded-xl bg-[#141824] border border-slate-800/90 space-y-2.5">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>Invite Code</span>
            <button
              onClick={handleCopyInvite}
              className="font-mono font-bold text-[#FFD100] hover:underline flex items-center gap-1 cursor-pointer"
            >
              <span>PITBOX-2026</span>
              <Copy className="w-3 h-3" />
            </button>
          </div>

          {firebaseUser ? (
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800">
              <span className="text-xs font-medium text-slate-200 truncate">
                {firebaseUser.displayName || firebaseUser.email}
              </span>
              <button
                onClick={() => signOut(auth)}
                className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowJoinModal(true)}
              className="w-full min-h-[38px] px-3 py-1.5 rounded-lg bg-[#FFD100] hover:bg-[#ffe033] text-black text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Claim Team / Sign Up</span>
            </button>
          )}
        </div>
      </aside>

      {/* ==========================================
          MAIN CONTENT VIEWPORT
      ========================================== */}
      <div className="flex-1 md:pl-60 flex flex-col min-h-screen pb-18 md:pb-8">
        {/* Mobile Top NASCAR 3-Color Telemetry Stripe */}
        <div className="md:hidden h-1 w-full flex">
          <div className="flex-1 bg-[#FFD100]" />
          <div className="flex-1 bg-[#E4002B]" />
          <div className="flex-1 bg-[#1D63FF]" />
        </div>

        {/* COMPACT 3-ZONE TOP BAR CONTRACT */}
        <header className="sticky top-0 z-20 bg-[#090A0F]/95 backdrop-blur-md border-b border-slate-800/80 px-3 py-2 md:px-6">
          <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
            {/* Zone 1: Brand Wordmark */}
            <a
              href="#top"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab('picks');
              }}
              className="font-display text-lg md:text-xl font-bold tracking-wider text-white whitespace-nowrap shrink-0"
            >
              PIT BOX · BRISTOL W36
            </a>

            {/* Zone 2: Desktop Quick Nav */}
            <nav className="hidden lg:flex items-center gap-5 text-xs font-semibold text-slate-400">
              {[
                { id: 'picks', label: 'My Lineup' },
                { id: 'standings', label: 'Scoreboard' },
                { id: 'bank', label: 'Driver Bank' },
                { id: 'draft', label: 'Season Roster' },
                { id: 'admin', label: 'League Hub' },
              ].map((nav) => (
                <button
                  key={nav.id}
                  onClick={() => setActiveTab(nav.id as any)}
                  className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    activeTab === nav.id ? 'text-[#FFD100]' : ''
                  }`}
                >
                  {nav.label}
                </button>
              ))}
            </nav>

            {/* Zone 3: Primary Action */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleManualSync}
                disabled={isSyncing}
                className="min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-bold bg-[#FFD100] hover:bg-[#ffe033] text-black transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`}
                />
                <span>{isSyncing ? 'Syncing...' : 'Sync Feed'}</span>
              </button>
            </div>
          </div>
        </header>

        {/* SLEEPER-STYLE COMPACT TEAM SUMMARY & ONBOARDING BAR */}
        <div className="bg-[#11141E] border-b border-slate-800/90 px-3 py-2 md:px-6">
          <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-2">
            {/* Active Team Selector + Rank & Live Score */}
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-[#1D2233] border border-slate-700 flex items-center justify-center font-mono font-bold text-xs text-[#FFD100] shrink-0">
                {activeUserRow?.avatar || 'PB'}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <select
                    value={activeManagerId}
                    onChange={(e) => setActiveManagerId(e.target.value)}
                    aria-label="Switch Active Manager"
                    className="bg-transparent text-xs md:text-sm font-bold text-white focus:outline-none cursor-pointer truncate max-w-[165px] sm:max-w-xs"
                  >
                    {(leagueState?.users || []).map((u) => (
                      <option
                        key={u.id}
                        value={u.id}
                        className="bg-[#11141E] text-white"
                      >
                        {u.name} {u.role === 'admin' ? '(Commish)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  Rank #{activeRank} · Wknd +{activeUserRow?.breakdown.weekendTotal || 0} · Total{' '}
                  {activeUserRow?.breakdown.grandTotal.toLocaleString() || 0} pts
                </div>
              </div>
            </div>

            {/* Join / Sign Up & Quick Toggles */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowJoinModal(true)}
                className="min-h-[34px] px-2.5 py-1 rounded-lg bg-[#1D2233] hover:bg-slate-700 border border-slate-700 text-[11px] font-semibold text-white flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
              >
                <UserPlus className="w-3 h-3 text-[#FFD100]" />
                <span>Join / Add Player</span>
              </button>

              <button
                onClick={() =>
                  handleUpdateAdminSetting({
                    simulateZilischInjury: !simulateZilischInjury,
                  })
                }
                className={`min-h-[34px] px-2.5 py-1 rounded-lg text-[11px] font-semibold border cursor-pointer whitespace-nowrap shrink-0 ${
                  simulateZilischInjury
                    ? 'bg-[#E4002B]/20 text-[#FF6B81] border-[#E4002B]/50'
                    : 'bg-[#161924] text-slate-400 border-slate-800'
                }`}
              >
                #88 Sub: {simulateZilischInjury ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        </div>

        {/* COMPACT TOAST BANNER */}
        {statusBanner && (
          <div className="max-w-5xl w-full mx-auto px-3 pt-2.5 md:px-6">
            <div
              className={`px-3 py-2 rounded-xl border text-xs flex items-center justify-between gap-2 ${
                statusBanner.type === 'error'
                  ? 'bg-[#E4002B]/15 border-[#E4002B]/40 text-red-200'
                  : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
              }`}
            >
              <div className="flex items-center gap-1.5">
                {statusBanner.type === 'error' ? (
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <Check className="w-3.5 h-3.5 shrink-0" />
                )}
                <span>{statusBanner.text}</span>
              </div>
              <button
                onClick={() => setStatusBanner(null)}
                className="text-slate-300 hover:text-white cursor-pointer text-[11px] font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* ==========================================
            MAIN VIEWPORT (COMPACT MOBILE-FIRST CONTAINER)
        ========================================== */}
        <main className="flex-1 max-w-5xl w-full mx-auto p-3 md:p-5 space-y-4">
          {/* ==========================================
              TAB 1: SLEEPER / ESPN-STYLE "MY LINEUP"
          ========================================== */}
          {activeTab === 'picks' && activeUserRow && (
            <div className="space-y-4">
              {/* Matchup / Weekend Scoreboard Strip */}
              <div className="bg-[#131722] border border-slate-800/90 rounded-2xl p-3.5 flex items-center justify-between gap-2">
                <div>
                  <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Active Lineup · {activeUserRow.name}
                  </div>
                  <div className="text-xs text-slate-300 mt-0.5">
                    Tap <span className="text-[#FFD100] font-semibold">SWAP</span> on any slot to set your Weekly Starters or adjust Season Anchors.
                  </div>
                </div>
                <div className="text-right font-mono shrink-0">
                  <div className="text-xl md:text-2xl font-bold text-[#FFD100]">
                    +{activeUserRow.breakdown.weekendTotal}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    WKND PTS ({firstPlacePoints} SCALE)
                  </div>
                </div>
              </div>

              {/* SECTION A: 3 WEEKLY STARTERS (Tap-to-Swap Sleeper Rows) */}
              <div className="bg-[#131722] border border-slate-800/90 rounded-2xl overflow-hidden">
                <div className="px-3.5 py-2.5 bg-[#171C29] border-b border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-sm font-bold tracking-wider uppercase text-white">
                      Weekly Starters (Blind Until Green Flag)
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {([3, 2, 1] as SeriesId[]).map((sId) => {
                      const locked = Boolean(
                        weekendRacesBySeries[sId]?.isLockedRevealed
                      );
                      return (
                        <button
                          key={sId}
                          onClick={() =>
                            handleUpdateAdminSetting({
                              raceLocks: { [sId]: !locked },
                            })
                          }
                          title="Commissioner: Toggle Green Flag Lock/Reveal"
                          className={`px-2 py-1 rounded text-[10px] font-mono font-bold border cursor-pointer flex items-center gap-1 ${
                            locked
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                              : 'bg-slate-800/90 text-slate-300 border-slate-700'
                          }`}
                        >
                          {locked ? (
                            <Unlock className="w-2.5 h-2.5" />
                          ) : (
                            <Lock className="w-2.5 h-2.5" />
                          )}
                          <span>{SERIES_META[sId].slotCode}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="divide-y divide-slate-800/80">
                  {([1, 2, 3] as SeriesId[]).map((sId) => {
                    const meta = SERIES_META[sId];
                    const raceObj = weekendRacesBySeries[sId];
                    const isActive = raceObj?.isActiveWeekend ?? true;
                    const isLocked = Boolean(raceObj?.isLockedRevealed);
                    const slotScore =
                      sId === 1
                        ? activeUserRow.breakdown.cupWeekly
                        : sId === 2
                        ? activeUserRow.breakdown.oreillysWeekly
                        : activeUserRow.breakdown.trucksWeekly;

                    const usage = slotScore.driverId
                      ? getDriverRemainingUses(slotScore.driverId, sId)
                      : null;

                    if (!isActive) {
                      return (
                        <div
                          key={sId}
                          className="px-3.5 py-3 flex items-center justify-between gap-3 opacity-60"
                        >
                          <div className="flex items-center gap-2.5">
                            <span
                              className={`w-11 py-1 text-center rounded font-mono text-[10px] font-bold border ${meta.pillBg}`}
                            >
                              {meta.slotCode}
                            </span>
                            <div className="text-xs text-slate-400">
                              No {meta.shortName} race scheduled this weekend
                            </div>
                          </div>
                          <button
                            onClick={() =>
                              handleUpdateAdminSetting({
                                activeSeriesWeekend: { [sId]: true },
                              })
                            }
                            className="px-2.5 py-1 rounded bg-slate-800 text-[11px] text-slate-200 cursor-pointer"
                          >
                            Enable
                          </button>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={sId}
                        className="px-3 py-2.5 flex items-center justify-between gap-2.5 hover:bg-[#191E2D] transition-colors"
                      >
                        {/* Left: Slot Pill + Car Pylon + Driver Details */}
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`w-11 py-1 text-center rounded-md font-mono text-[10px] font-bold border shrink-0 ${meta.pillBg}`}
                          >
                            {meta.slotCode}
                            <div className="text-[8px] opacity-80">WKLY</div>
                          </div>

                          {/* Stylized NASCAR Car Number Pylon */}
                          <div
                            className={`w-9 h-9 rounded-lg font-display font-bold text-base flex items-center justify-center shrink-0 shadow-sm ${meta.pylonBg}`}
                          >
                            #{slotScore.carNumber}
                          </div>

                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-sm text-white truncate">
                                {slotScore.driverName}
                              </span>
                              {usage && (
                                <span className="font-mono text-[10px] text-emerald-400 shrink-0">
                                  {usage.remaining}/{usage.maxUses} Left
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400 truncate">
                              {slotScore.teamName} · {raceObj?.raceName}
                              {slotScore.isOwnerPts ? ' · Owner Pts' : ''}
                            </div>
                          </div>
                        </div>

                        {/* Right: Live Points + Swap Action */}
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="text-right font-mono">
                            <div className="text-sm font-bold text-white">
                              {slotScore.points}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              {slotScore.finishPos
                                ? `P${slotScore.finishPos}`
                                : 'PTS'}
                            </div>
                          </div>

                          <button
                            disabled={isLocked}
                            onClick={() => setSwapWeeklyDrawerSeries(sId)}
                            className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer ${
                              isLocked
                                ? 'bg-slate-800/60 text-slate-500 cursor-not-allowed'
                                : 'bg-[#22283B] hover:bg-[#2C344D] text-[#FFD100] border border-slate-700'
                            }`}
                          >
                            {isLocked ? (
                              <>
                                <Lock className="w-3 h-3" />
                                <span>LOCKED</span>
                              </>
                            ) : (
                              <>
                                <ArrowLeftRight className="w-3 h-3" />
                                <span>SWAP</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* SECTION B: 5 SEASON-LONG ROSTER SLOTS (With Car Anchor Protection) */}
              <div className="bg-[#131722] border border-slate-800/90 rounded-2xl overflow-hidden">
                <div className="px-3.5 py-2.5 bg-[#171C29] border-b border-slate-800 flex items-center justify-between">
                  <span className="font-display text-sm font-bold tracking-wider uppercase text-white">
                    Season-Long Roster (4 Exclusive + 5th Chase Bonus)
                  </span>
                  <span className="font-mono text-xs font-bold text-slate-300">
                    +{activeUserRow.breakdown.seasonOnlyWeekendTotal} pts
                  </span>
                </div>

                <div className="divide-y divide-slate-800/80">
                  {[
                    {
                      slotType: 'cup_prev_chase',
                      code: 'CHASE',
                      sub: 'CUP SZN',
                      seriesId: 1 as SeriesId,
                      exclusive: true,
                      data: activeUserRow.breakdown.cupSeasonChase,
                    },
                    {
                      slotType: 'cup_prev_non_chase',
                      code: 'NON-CH',
                      sub: 'CUP SZN',
                      seriesId: 1 as SeriesId,
                      exclusive: true,
                      data: activeUserRow.breakdown.cupSeasonNonChase,
                    },
                    {
                      slotType: 'oreillys_season',
                      code: 'ORL',
                      sub: 'SEASON',
                      seriesId: 2 as SeriesId,
                      exclusive: true,
                      data: activeUserRow.breakdown.oreillysSeason,
                    },
                    {
                      slotType: 'trucks_season',
                      code: 'TRK',
                      sub: 'SEASON',
                      seriesId: 3 as SeriesId,
                      exclusive: true,
                      data: activeUserRow.breakdown.trucksSeason,
                    },
                    {
                      slotType: 'cup_current_chase',
                      code: 'BONUS',
                      sub: '5TH SLOT',
                      seriesId: 1 as SeriesId,
                      exclusive: false,
                      data: activeUserRow.breakdown.cupMidSeasonBonus,
                    },
                  ].map((row) => {
                    const meta = SERIES_META[row.seriesId];
                    return (
                      <div
                        key={row.slotType}
                        className="px-3 py-2.5 flex items-center justify-between gap-2.5 hover:bg-[#191E2D] transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`w-11 py-1 text-center rounded-md font-mono text-[10px] font-bold border shrink-0 ${meta.pillBg}`}
                          >
                            {row.code}
                            <div className="text-[8px] opacity-80">
                              {row.sub}
                            </div>
                          </div>

                          <div
                            className={`w-9 h-9 rounded-lg font-display font-bold text-base flex items-center justify-center shrink-0 ${meta.pylonBg}`}
                          >
                            #{row.data.actualCarNumber}
                          </div>

                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`font-bold text-sm truncate ${
                                  row.data.usedCarAnchor
                                    ? 'text-emerald-300'
                                    : 'text-white'
                                }`}
                              >
                                {row.data.driverName}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-400 truncate">
                              {row.data.teamName} · Anchor #
                              {row.data.slotRow?.fallbackCarNumber ||
                                row.data.actualCarNumber}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <div className="text-right font-mono">
                            <div className="text-sm font-bold text-white">
                              {row.data.points}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              {row.data.usedCarAnchor ? 'ANCHOR' : 'PTS'}
                            </div>
                          </div>

                          <button
                            onClick={() =>
                              setSwapSeasonDrawerSlot({
                                slotType: row.slotType,
                                label: `${row.code} (${row.sub})`,
                                seriesId: row.seriesId,
                                exclusive: row.exclusive,
                              })
                            }
                            className="min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs font-bold bg-[#22283B] hover:bg-[#2C344D] text-slate-200 border border-slate-700 flex items-center gap-1 cursor-pointer"
                          >
                            <ArrowLeftRight className="w-3 h-3 text-[#FFD100]" />
                            <span>EDIT</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ==========================================
              TAB 2: SLEEPER-STYLE EXPANDABLE SCOREBOARD
              (Zero Horizontal Table Scroll on Mobile!)
          ========================================== */}
          {activeTab === 'standings' && (
            <div className="space-y-3.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div>
                  <h1 className="font-display text-2xl font-bold tracking-wide text-white">
                    League Live Scoreboard &amp; Standings
                  </h1>
                  <p className="text-xs text-slate-400">
                    Tap any manager card to expand their 8-slot weekend breakdown. Blind weekly picks stay hidden until Green Flag.
                  </p>
                </div>

                {/* Segmented Filter */}
                <div className="flex items-center gap-1 p-1 bg-[#131722] rounded-xl border border-slate-800 self-start">
                  {[
                    { id: 'all', label: 'Combined' },
                    { id: 'weekly_only', label: 'Weekly Only' },
                    { id: 'season_only', label: 'Roster Only' },
                  ].map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setStandingsViewFilter(f.id as any)}
                      className={`min-h-[34px] px-3 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                        standingsViewFilter === f.id
                          ? 'bg-[#FFD100] text-black'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Stacked Mobile-Friendly Manager Cards */}
              <div className="space-y-2.5">
                {leaderboard.map((member, idx) => {
                  const b = member.breakdown;
                  const isMe = member.id === activeManagerId;
                  const isExpanded = Boolean(expandedMemberIds[member.id]);

                  const cupRevealed =
                    Boolean(weekendRacesBySeries[1]?.isLockedRevealed) || isMe;
                  const orlRevealed =
                    Boolean(weekendRacesBySeries[2]?.isLockedRevealed) || isMe;
                  const trkRevealed =
                    Boolean(weekendRacesBySeries[3]?.isLockedRevealed) || isMe;

                  return (
                    <div
                      key={member.id}
                      className={`bg-[#131722] border rounded-2xl overflow-hidden transition-colors ${
                        isMe ? 'border-[#FFD100]/50' : 'border-slate-800/90'
                      }`}
                    >
                      {/* Top Summary Row (Always Visible, Tap to Expand) */}
                      <button
                        onClick={() =>
                          setExpandedMemberIds((prev) => ({
                            ...prev,
                            [member.id]: !prev[member.id],
                          }))
                        }
                        className="w-full px-3.5 py-3 flex items-center justify-between gap-2 text-left hover:bg-[#181D2B] transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className={`w-6 h-6 rounded-md font-mono text-xs font-bold flex items-center justify-center shrink-0 ${
                              idx === 0
                                ? 'bg-[#FFD100] text-black'
                                : 'bg-slate-800 text-slate-300'
                            }`}
                          >
                            {idx + 1}
                          </span>
                          <div className="w-8 h-8 rounded-lg bg-[#1E2436] border border-slate-700 flex items-center justify-center font-mono text-xs font-bold text-white shrink-0">
                            {member.avatar}
                          </div>
                          <div className="min-w-0">
                            <div className="font-bold text-sm text-white truncate">
                              {member.name}
                            </div>
                            <div className="text-[11px] text-slate-400 font-mono">
                              Wk +{b.weeklyOnlyWeekendTotal} · Ros +
                              {b.seasonOnlyWeekendTotal} · Prior{' '}
                              {member.cumulativePriorPoints}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <div className="text-right font-mono">
                            <div className="text-sm font-bold text-emerald-400">
                              {b.grandTotal.toLocaleString()} pts
                            </div>
                            <div className="text-[11px] font-bold text-[#FFD100]">
                              +{b.weekendTotal} wknd
                            </div>
                          </div>
                          {isExpanded ? (
                            <ChevronUp className="w-4 h-4 text-slate-400" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-slate-400" />
                          )}
                        </div>
                      </button>

                      {/* Expanded 8-Slot Telemetry Breakdown */}
                      {isExpanded && (
                        <div className="px-3.5 pb-3.5 pt-2 border-t border-slate-800/80 bg-[#0E111A] grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs">
                          {/* Cup Column */}
                          <div className="p-2.5 rounded-xl bg-[#141824] border border-slate-800/80 space-y-1.5">
                            <div className="flex items-center justify-between font-bold text-[#FFD100]">
                              <span>CUP SERIES</span>
                              <span className="font-mono">{b.cupTotal} pts</span>
                            </div>
                            <div className="flex items-center justify-between text-slate-200 font-mono text-[11px]">
                              <span className="truncate">
                                [WK]{' '}
                                {cupRevealed
                                  ? `#${b.cupWeekly.carNumber} ${b.cupWeekly.driverName}`
                                  : '🔒 Pick Locked In'}
                              </span>
                              <span className="font-bold ml-2">
                                {cupRevealed ? b.cupWeekly.points : '-'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-slate-300 font-mono text-[11px]">
                              <span className="truncate">
                                [CH] #{b.cupSeasonChase.actualCarNumber}{' '}
                                {b.cupSeasonChase.driverName}
                              </span>
                              <span>{b.cupSeasonChase.points}</span>
                            </div>
                            <div className="flex items-center justify-between text-slate-300 font-mono text-[11px]">
                              <span className="truncate">
                                [NC] #{b.cupSeasonNonChase.actualCarNumber}{' '}
                                {b.cupSeasonNonChase.driverName}
                              </span>
                              <span>{b.cupSeasonNonChase.points}</span>
                            </div>
                            {midSeasonChaseActive && (
                              <div className="flex items-center justify-between text-amber-300 font-mono text-[11px]">
                                <span className="truncate">
                                  [5TH] #{b.cupMidSeasonBonus.actualCarNumber}{' '}
                                  {b.cupMidSeasonBonus.driverName}
                                </span>
                                <span>{b.cupMidSeasonBonus.points}</span>
                              </div>
                            )}
                          </div>

                          {/* O'Reilly's Column */}
                          <div className="p-2.5 rounded-xl bg-[#141824] border border-slate-800/80 space-y-1.5">
                            <div className="flex items-center justify-between font-bold text-[#FF4D6D]">
                              <span>O&apos;REILLY&apos;S SERIES</span>
                              <span className="font-mono">
                                {b.oreillysTotal} pts
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-slate-200 font-mono text-[11px]">
                              <span className="truncate">
                                [WK]{' '}
                                {orlRevealed
                                  ? `#${b.oreillysWeekly.carNumber} ${b.oreillysWeekly.driverName}`
                                  : '🔒 Pick Locked In'}
                              </span>
                              <span className="font-bold ml-2">
                                {orlRevealed ? b.oreillysWeekly.points : '-'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-slate-300 font-mono text-[11px]">
                              <span className="truncate">
                                [SZN] {b.oreillysSeason.driverName}
                              </span>
                              <span className="font-bold text-emerald-400">
                                {b.oreillysSeason.points}
                              </span>
                            </div>
                          </div>

                          {/* Trucks Column */}
                          <div className="p-2.5 rounded-xl bg-[#141824] border border-slate-800/80 space-y-1.5">
                            <div className="flex items-center justify-between font-bold text-[#609BFF]">
                              <span>TRUCK SERIES</span>
                              <span className="font-mono">
                                {b.trucksTotal} pts
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-slate-200 font-mono text-[11px]">
                              <span className="truncate">
                                [WK]{' '}
                                {trkRevealed
                                  ? `#${b.trucksWeekly.carNumber} ${b.trucksWeekly.driverName}`
                                  : '🔒 Pick Locked In'}
                              </span>
                              <span className="font-bold ml-2">
                                {trkRevealed ? b.trucksWeekly.points : '-'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-slate-300 font-mono text-[11px]">
                              <span className="truncate">
                                [SZN] #{b.trucksSeason.actualCarNumber}{' '}
                                {b.trucksSeason.driverName}
                              </span>
                              <span>{b.trucksSeason.points}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ==========================================
              TAB 3: COMPACT SLEEPER-STYLE DRIVER USAGE BANK
          ========================================== */}
          {activeTab === 'bank' && (
            <div className="space-y-3.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div>
                  <h1 className="font-display text-2xl font-bold tracking-wide text-white">
                    Driver Usage Bank (5 Max Uses / Season)
                  </h1>
                  <p className="text-xs text-slate-400">
                    Track remaining starts for {activeUserRow?.name} and tap{' '}
                    <span className="text-[#FFD100] font-semibold">START</span>{' '}
                    to slot an eligible driver into this week&apos;s lineup.
                  </p>
                </div>

                <div className="flex items-center gap-1 p-1 bg-[#131722] rounded-xl border border-slate-800 self-start">
                  {([1, 2, 3] as SeriesId[]).map((sId) => (
                    <button
                      key={sId}
                      onClick={() => setBankSeriesFilter(sId)}
                      className={`min-h-[34px] px-3 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                        bankSeriesFilter === sId
                          ? SERIES_META[sId].pylonBg
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {SERIES_META[sId].shortName}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-[#131722] border border-slate-800/90 rounded-2xl divide-y divide-slate-800/80 overflow-hidden">
                {(leagueState?.drivers || [])
                  .filter((d) => d.seriesId === bankSeriesFilter)
                  .map((driver) => {
                    const sId = driver.seriesId as SeriesId;
                    const meta = SERIES_META[sId];
                    const usage = getDriverRemainingUses(driver.id, sId);
                    const isDepleted = usage.remaining === 0;
                    const raceLocked = Boolean(
                      weekendRacesBySeries[sId]?.isLockedRevealed
                    );

                    return (
                      <div
                        key={driver.id}
                        className={`px-3.5 py-2.5 flex items-center justify-between gap-3 ${
                          isDepleted ? 'opacity-55' : 'hover:bg-[#181D2B]'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`w-9 h-9 rounded-lg font-display font-bold text-base flex items-center justify-center shrink-0 ${meta.pylonBg}`}
                          >
                            #{driver.carNumber}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-sm text-white truncate">
                                {driver.fullName}
                              </span>
                              <span
                                className={`font-mono text-[11px] font-bold ${
                                  isDepleted
                                    ? 'text-[#FF4D6D]'
                                    : 'text-emerald-400'
                                }`}
                              >
                                {usage.remaining}/{usage.maxUses} Left
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-400 truncate">
                              {driver.team} · Used:{' '}
                              {usage.pastTracks.length > 0
                                ? usage.pastTracks.join(', ')
                                : 'None'}
                            </div>
                          </div>
                        </div>

                        <div className="shrink-0">
                          {usage.isCurrentlyPicked ? (
                            <span className="px-2.5 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-xs font-bold">
                              STARTING
                            </span>
                          ) : (
                            <button
                              disabled={isDepleted || raceLocked}
                              onClick={() =>
                                handleSelectWeeklyPick(sId, driver.id)
                              }
                              className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#22283B] hover:bg-[#FFD100] hover:text-black text-xs font-bold text-white disabled:opacity-40 cursor-pointer transition-colors"
                            >
                              {isDepleted
                                ? '0 LEFT'
                                : raceLocked
                                ? 'LOCKED'
                                : 'START'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* ==========================================
              TAB 4: SLEEPER-STYLE DRAFT BOARD & SEASON ROSTERS
          ========================================== */}
          {activeTab === 'draft' && (
            <div className="space-y-4">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
                <div>
                  <h1 className="font-display text-2xl font-bold tracking-wide text-white">
                    Live Draft Room &amp; Season Rosters
                  </h1>
                  <p className="text-xs text-slate-400">
                    4-Round Exclusive Draft (1 Cup Chase, 1 Cup Non-Chase, 1 O&apos;Reilly&apos;s, 1 Trucks — locked league-wide) + 5th Chase Bonus.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() =>
                      setDraftOrderMode(
                        draftOrderMode === 'reverse_standings'
                          ? 'random'
                          : 'reverse_standings'
                      )
                    }
                    className="min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold bg-[#131722] border border-slate-700 text-slate-200 flex items-center gap-1.5 cursor-pointer"
                  >
                    <ArrowUpDown className="w-3.5 h-3.5 text-[#FFD100]" />
                    <span>
                      {draftOrderMode === 'reverse_standings'
                        ? 'Reverse Standings'
                        : 'Random Order'}
                    </span>
                  </button>

                  <button
                    onClick={handleShuffleDraftOrder}
                    className="min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold bg-[#131722] border border-slate-700 text-slate-200 hover:border-[#FFD100] flex items-center gap-1.5 cursor-pointer"
                    title="Randomize draft order"
                  >
                    <Shuffle className="w-3.5 h-3.5 text-[#609BFF]" />
                    <span>Shuffle</span>
                  </button>

                  <button
                    onClick={() =>
                      setDraftFormat(draftFormat === 'snake' ? 'linear' : 'snake')
                    }
                    className="min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold bg-[#131722] border border-slate-700 text-slate-200 cursor-pointer"
                  >
                    {draftFormat === 'snake' ? 'Snake Draft' : 'Linear Draft'}
                  </button>

                  {isCurrentUserAdmin && (
                    <button
                      onClick={() =>
                        handleDraftAction(
                          { action: 'reset_draft' },
                          'Fresh initial draft started! Exclusive season slots cleared.'
                        )
                      }
                      className="min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold bg-[#E4002B] text-white hover:bg-[#c80026] flex items-center gap-1.5 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Start Fresh Draft</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Draft Progress Banner & Live On-The-Clock Picker */}
              {(() => {
                const slotCfg: Record<
                  'cup_prev_chase' | 'cup_prev_non_chase' | 'oreillys_season' | 'trucks_season',
                  { label: string; seriesId: SeriesId; badge: string; filter: (d: DbDriver) => boolean }
                > = {
                  cup_prev_chase: {
                    label: 'Cup Chase',
                    seriesId: 1,
                    badge: 'bg-[#FFD100] text-black',
                    filter: (d) => d.madeLastYearChase,
                  },
                  cup_prev_non_chase: {
                    label: 'Cup Non-Chase',
                    seriesId: 1,
                    badge: 'bg-[#FFD100]/20 text-[#FFD100] border border-[#FFD100]/40',
                    filter: (d) => !d.madeLastYearChase,
                  },
                  oreillys_season: {
                    label: "O'Reilly's",
                    seriesId: 2,
                    badge: 'bg-[#E4002B] text-white',
                    filter: () => true,
                  },
                  trucks_season: {
                    label: 'Trucks',
                    seriesId: 3,
                    badge: 'bg-[#1D63FF] text-white',
                    filter: () => true,
                  },
                };

                if (draftProgress.isComplete || !draftProgress.onTheClock) {
                  return (
                    <div className="bg-[#131722] border border-emerald-500/40 rounded-2xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                        <div>
                          <div className="text-sm font-bold text-white">
                            Pre-Season Exclusive Draft Complete ({draftProgress.totalDrafted}/{draftProgress.totalNeeded} Picks)
                          </div>
                          <div className="text-xs text-slate-400">
                            All 4 exclusive season slots are filled. Managers can swap open drivers below, or the Commissioner can restart the draft above.
                          </div>
                        </div>
                      </div>
                      {!isCurrentUserAdmin && primaryAdmin && (
                        <button
                          onClick={() => setActiveManagerId(primaryAdmin.id)}
                          className="min-h-[36px] px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-[#FFD100] shrink-0 cursor-pointer"
                        >
                          Switch to {primaryAdmin.name} (Commish)
                        </button>
                      )}
                    </div>
                  );
                }

                const onClock = draftProgress.onTheClock;
                const canDraftNow =
                  activeManagerId === onClock.user.id || isCurrentUserAdmin;
                const currentSlotCfg = slotCfg[selectedDraftSlotType];
                const takenExclusiveDriverIds = new Set(
                  (leagueState?.seasonRosters || [])
                    .filter((r) => r.slotType !== 'cup_current_chase')
                    .map((r) => r.driverId)
                );
                const availableDrivers = (leagueState?.drivers || []).filter(
                  (d) =>
                    d.seriesId === currentSlotCfg.seriesId &&
                    !d.isBuschwhacker &&
                    !takenExclusiveDriverIds.has(d.id) &&
                    currentSlotCfg.filter(d)
                );

                return (
                  <div className="bg-[#131722] border border-[#FFD100]/60 rounded-2xl p-4 space-y-3 shadow-lg shadow-black/40">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
                      <div className="flex items-center gap-2.5">
                        <span className="px-2.5 py-1 rounded-lg bg-[#FFD100] text-black font-mono text-xs font-black">
                          PICK {onClock.label}
                        </span>
                        <div>
                          <div className="text-sm font-bold text-white flex items-center gap-1.5">
                            <span>On The Clock: {onClock.user.name}</span>
                            {onClock.user.id === activeManagerId && (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono text-[10px]">
                                YOUR PICK
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            Progress: {draftProgress.totalDrafted} of {draftProgress.totalNeeded} exclusive picks drafted • Pick any open category below
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {!canDraftNow && (
                          <button
                            onClick={() => setActiveManagerId(onClock.user.id)}
                            className="min-h-[36px] px-3 py-1.5 rounded-xl bg-slate-800 text-xs font-bold text-[#FFD100] cursor-pointer"
                          >
                            Act as {onClock.user.name}
                          </button>
                        )}
                        {canDraftNow && (
                          <button
                            onClick={handleAutoPickForClock}
                            className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#1D63FF] hover:bg-[#1552db] text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>Auto-Pick Best</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Open Category Selector for the Manager On The Clock */}
                    <div className="flex flex-wrap gap-1.5">
                      {draftProgress.openSlotsForOnClock.map((st) => {
                        const meta = slotCfg[st];
                        const active = selectedDraftSlotType === st;
                        return (
                          <button
                            key={st}
                            onClick={() => setSelectedDraftSlotType(st)}
                            className={`min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold border transition cursor-pointer ${
                              active
                                ? 'bg-[#1D2436] border-[#FFD100] text-white'
                                : 'bg-[#0E111A] border-slate-800 text-slate-400 hover:text-white'
                            }`}
                          >
                            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] mr-1.5 ${meta.badge}`}>
                              R{onClock.round}
                            </span>
                            {meta.label}
                          </button>
                        );
                      })}
                    </div>

                    {/* Available Drivers Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-64 overflow-y-auto pr-1">
                      {availableDrivers.map((d) => (
                        <div
                          key={d.id}
                          className="p-2.5 rounded-xl bg-[#0E111A] border border-slate-800 flex items-center justify-between gap-2"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`w-8 h-8 rounded-lg font-display font-bold text-sm flex items-center justify-center shrink-0 ${
                                SERIES_META[currentSlotCfg.seriesId].pylonBg
                              }`}
                            >
                              {d.carNumber}
                            </span>
                            <div className="min-w-0">
                              <div className="text-xs font-bold text-white truncate">
                                {d.fullName}
                              </div>
                              <div className="text-[10px] text-slate-400 truncate">
                                {d.team} • Anchor #{d.carNumber}
                              </div>
                            </div>
                          </div>
                          <button
                            disabled={!canDraftNow}
                            onClick={() =>
                              handleDraftAction(
                                {
                                  action: 'submit_pick',
                                  targetUserId: onClock.user.id,
                                  seriesId: currentSlotCfg.seriesId,
                                  slotType: selectedDraftSlotType,
                                  driverId: d.id,
                                  fallbackCarNumber: d.carNumber,
                                },
                                `${onClock.user.name} drafted #${d.carNumber} ${d.fullName} (${onClock.label})!`
                              )
                            }
                            className={`min-h-[34px] px-2.5 py-1 rounded-lg text-[11px] font-bold shrink-0 ${
                              canDraftNow
                                ? 'bg-[#FFD100] text-black hover:bg-amber-300 cursor-pointer'
                                : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                            }`}
                          >
                            DRAFT
                          </button>
                        </div>
                      ))}
                      {availableDrivers.length === 0 && (
                        <div className="col-span-full text-xs text-slate-400 p-3 rounded-xl bg-[#0E111A] border border-slate-800">
                          No undrafted eligible drivers remain in this category.
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Full 4-Round Draft Queue Strip */}
              <div className="bg-[#131722] border border-slate-800/90 rounded-2xl p-3 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                  <span>
                    DRAFT QUEUE ({draftFormat.toUpperCase()} • {draftOrderMode === 'reverse_standings' ? 'REVERSE STANDINGS' : 'RANDOMIZED'})
                  </span>
                  <span>
                    {draftProgress.totalDrafted}/{draftProgress.totalNeeded} FILLED
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-1.5">
                  {draftProgress.queue.slice(0, Math.max(12, sortedDraftOrder.length * 4)).map((q) => {
                    const isClock = draftProgress.onTheClock?.overall === q.overall;
                    return (
                      <div
                        key={q.overall}
                        className={`p-2 rounded-xl border flex items-center gap-2 ${
                          isClock
                            ? 'bg-[#FFD100]/15 border-[#FFD100]'
                            : q.isFilled
                            ? 'bg-emerald-500/10 border-emerald-500/30 opacity-80'
                            : 'bg-[#0E111A] border-slate-800'
                        }`}
                      >
                        <span
                          className={`font-mono text-[11px] font-bold ${
                            isClock
                              ? 'text-[#FFD100]'
                              : q.isFilled
                              ? 'text-emerald-400'
                              : 'text-slate-400'
                          }`}
                        >
                          {q.label}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] font-bold text-white truncate">
                            {q.user.name}
                          </div>
                          <div className="text-[9px] font-mono text-slate-400">
                            {isClock ? 'ON CLOCK' : q.isFilled ? 'DRAFTED' : `Prev #${q.user.lastYearRank}`}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Compact Stacked Season Roster Cards per Team */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {(leagueState?.users || []).map((member) => {
                  const isMe = member.id === activeManagerId;
                  const slots = [
                    {
                      slotType: 'cup_prev_chase',
                      label: 'Cup Chase',
                      sId: 1 as SeriesId,
                      exclusive: true,
                    },
                    {
                      slotType: 'cup_prev_non_chase',
                      label: 'Cup Non-Chase',
                      sId: 1 as SeriesId,
                      exclusive: true,
                    },
                    {
                      slotType: 'oreillys_season',
                      label: "O'Reilly's",
                      sId: 2 as SeriesId,
                      exclusive: true,
                    },
                    {
                      slotType: 'trucks_season',
                      label: 'Trucks',
                      sId: 3 as SeriesId,
                      exclusive: true,
                    },
                    {
                      slotType: 'cup_current_chase',
                      label: '5th Chase Bonus',
                      sId: 1 as SeriesId,
                      exclusive: false,
                    },
                  ];

                  return (
                    <div
                      key={member.id}
                      className={`bg-[#131722] border rounded-2xl p-3.5 space-y-2.5 ${
                        isMe ? 'border-[#FFD100]/50' : 'border-slate-800/90'
                      }`}
                    >
                      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded bg-[#1E2436] font-mono text-xs font-bold text-[#FFD100] flex items-center justify-center">
                            {member.avatar}
                          </span>
                          <span className="font-bold text-sm text-white">
                            {member.name}
                          </span>
                        </div>
                        {isMe && (
                          <span className="text-[10px] font-mono font-bold text-[#FFD100]">
                            ACTIVE TEAM
                          </span>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        {slots.map((s) => {
                          const row = (leagueState?.seasonRosters || []).find(
                            (r) =>
                              r.userId === member.id &&
                              r.slotType === s.slotType
                          );
                          const drv = (leagueState?.drivers || []).find(
                            (d) => d.id === row?.driverId
                          );
                          return (
                            <div
                              key={s.slotType}
                              className="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-[#0E111A]"
                            >
                              <span className="text-slate-400 font-medium w-28 shrink-0">
                                {s.label}
                              </span>
                              <span className="font-semibold text-white truncate flex-1">
                                {drv
                                  ? `#${drv.carNumber} ${drv.fullName}`
                                  : 'Unassigned'}
                              </span>
                              {isMe ? (
                                <button
                                  onClick={() =>
                                    setSwapSeasonDrawerSlot({
                                      slotType: s.slotType,
                                      label: s.label,
                                      seriesId: s.sId,
                                      exclusive: s.exclusive,
                                    })
                                  }
                                  className="ml-2 text-[11px] font-bold text-[#FFD100] hover:underline cursor-pointer"
                                >
                                  Change
                                </button>
                              ) : (
                                <span className="ml-2 font-mono text-[10px] text-slate-400">
                                  Anchor #{row?.fallbackCarNumber || '-'}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ==========================================
              TAB 5: LEAGUE HUB, ONBOARDING & COMMISSIONER CONTROLS
          ========================================== */}
          {activeTab === 'admin' && (
            <div className="space-y-4">
              {/* How League Managers & Members Use the App (Invite + Sign-Up Hub) */}
              <div className="bg-[#131722] border border-slate-800/90 rounded-2xl p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h1 className="font-display text-2xl font-bold tracking-wide text-white">
                      League Invite Hub &amp; Commissioner Console
                    </h1>
                    <p className="text-xs text-slate-400">
                      Share your invite code so friends can claim a team, or manage Buschwhacker Owner Points &amp; Car Anchor rules.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCopyInvite}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#1D2233] border border-slate-700 text-xs font-mono font-bold text-[#FFD100] flex items-center gap-1.5 cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>
                        {copiedInvite ? 'Copied!' : 'Invite Code: PITBOX-2026'}
                      </span>
                    </button>
                    <button
                      onClick={() => setShowJoinModal(true)}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#FFD100] text-black text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      <span>Add / Sign Up Player</span>
                    </button>
                  </div>
                </div>

                {/* 3-Step Workflow Guide for Managers & Players */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-1 text-xs">
                  <div className="p-3 rounded-xl bg-[#0E111A] border border-slate-800/80">
                    <div className="font-bold text-[#FFD100]">
                      1. Invite &amp; Claim Teams
                    </div>
                    <p className="text-slate-400 mt-1 leading-relaxed">
                      Players click <strong className="text-white">Join / Add Player</strong> with code{' '}
                      <span className="font-mono text-white">PITBOX-2026</span> or Google Sign-In to join the league and draft their 4 exclusive season drivers.
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-[#0E111A] border border-slate-800/80">
                    <div className="font-bold text-[#FF4D6D]">
                      2. Blind Weekly Starters
                    </div>
                    <p className="text-slate-400 mt-1 leading-relaxed">
                      Every week, managers tap <strong className="text-white">SWAP</strong> in My Lineup to pick 1 Cup, 1 O&apos;Reilly&apos;s, and 1 Truck starter (5 uses/driver cap). Picks stay hidden until Green Flag.
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-[#0E111A] border border-slate-800/80">
                    <div className="font-bold text-[#609BFF]">
                      3. Zero Manual Scoring
                    </div>
                    <p className="text-slate-400 mt-1 leading-relaxed">
                      <span className="font-mono text-white">/api/nascar-sync</span> pulls live &amp; official results from{' '}
                      <span className="font-mono text-white">cf.nascar.com</span>, awarding full Vehicle Owner Points to Buschwhackers &amp; Car Anchors.
                    </p>
                  </div>
                </div>
              </div>

              {/* League Admin Role & Commissioner Access Card */}
              <div className="bg-[#131722] border border-slate-800/90 rounded-2xl p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-[#FFD100]/15 border border-[#FFD100]/40 flex items-center justify-center shrink-0">
                      <Crown className="w-4 h-4 text-[#FFD100]" />
                    </div>
                    <div>
                      <h2 className="font-display text-lg font-bold tracking-wide uppercase text-white">
                        League Admin (Commissioner) Access
                      </h2>
                      <p className="text-xs text-slate-400">
                        First Google Sign-In automatically claims Commissioner Seat #1 (currently{' '}
                        <span className="text-white font-semibold">
                          {primaryAdmin?.name || 'Seat #1'}
                        </span>
                        ), or any manager can unlock Commissioner powers below with passcode{' '}
                        <span className="font-mono text-[#FFD100]">COMMISH-2026</span>.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`px-2.5 py-1 rounded-lg font-mono text-[11px] font-bold ${
                        isCurrentUserAdmin
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {isCurrentUserAdmin ? 'ADMIN ACTIVE' : 'MEMBER VIEW'}
                    </span>
                    {!isCurrentUserAdmin && primaryAdmin && (
                      <button
                        onClick={() => setActiveManagerId(primaryAdmin.id)}
                        className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#FFD100] text-black text-xs font-bold cursor-pointer"
                      >
                        Switch to {primaryAdmin.name}
                      </button>
                    )}
                  </div>
                </div>

                {!isCurrentUserAdmin && (
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-2 border-t border-slate-800/80">
                    <input
                      type="text"
                      value={adminPasscode}
                      onChange={(e) => setAdminPasscode(e.target.value)}
                      placeholder="Enter Commissioner Passcode (e.g. COMMISH-2026)"
                      className="flex-1 min-h-[38px] bg-[#090A0F] border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-white"
                    />
                    <button
                      onClick={() =>
                        handleAdminTeamAction(
                          {
                            action: 'claim_admin',
                            targetUserId: activeManagerId,
                            passcode: adminPasscode,
                          },
                          `${activeUserRow?.name || 'Team'} promoted to League Admin!`
                        )
                      }
                      className="min-h-[38px] px-4 py-1.5 rounded-xl bg-[#1D63FF] hover:bg-[#1552db] text-white text-xs font-bold cursor-pointer shrink-0"
                    >
                      Claim Admin Role
                    </button>
                  </div>
                )}
              </div>

              {/* Commissioner Full Team Control Center */}
              {isCurrentUserAdmin && (() => {
                const targetTeam =
                  (leagueState?.users || []).find((u) => u.id === adminTargetUserId) ||
                  leagueState?.users?.[0];

                const seasonSlotDefs: Array<{
                  slotType: string;
                  label: string;
                  seriesId: SeriesId;
                  filter: (d: DbDriver) => boolean;
                }> = [
                  {
                    slotType: 'cup_prev_chase',
                    label: 'Cup Chase (Excl)',
                    seriesId: 1,
                    filter: (d) => d.madeLastYearChase,
                  },
                  {
                    slotType: 'cup_prev_non_chase',
                    label: 'Cup Non-Chase (Excl)',
                    seriesId: 1,
                    filter: (d) => !d.madeLastYearChase,
                  },
                  {
                    slotType: 'oreillys_season',
                    label: "O'Reilly's (Excl)",
                    seriesId: 2,
                    filter: () => true,
                  },
                  {
                    slotType: 'trucks_season',
                    label: 'Trucks (Excl)',
                    seriesId: 3,
                    filter: () => true,
                  },
                  {
                    slotType: 'cup_current_chase',
                    label: '5th Cup Chase Bonus',
                    seriesId: 1,
                    filter: (d) => d.madeLastYearChase,
                  },
                ];

                return (
                  <div className="bg-[#131722] border border-[#FFD100]/40 rounded-2xl p-4 space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
                      <div>
                        <h2 className="font-display text-lg font-bold tracking-wide uppercase text-white">
                          Commissioner Team Control Center
                        </h2>
                        <p className="text-xs text-slate-400">
                          Full override authority over every team&apos;s name, role, standings points, weekly starters (bypasses Green Flag locks), and season rosters.
                        </p>
                      </div>
                      <span className="px-2.5 py-1 rounded-lg bg-[#FFD100]/15 text-[#FFD100] font-mono text-[11px] font-bold self-start">
                        COMMISH OVERRIDE MODE
                      </span>
                    </div>

                    {/* Team Selector Pills */}
                    <div className="flex flex-wrap gap-1.5">
                      {(leagueState?.users || []).map((u) => {
                        const selected = targetTeam?.id === u.id;
                        return (
                          <button
                            key={u.id}
                            onClick={() => setAdminTargetUserId(u.id)}
                            className={`min-h-[36px] px-3 py-1.5 rounded-xl text-xs font-bold border flex items-center gap-1.5 cursor-pointer ${
                              selected
                                ? 'bg-[#FFD100] text-black border-[#FFD100]'
                                : 'bg-[#0E111A] text-slate-300 border-slate-800 hover:border-slate-600'
                            }`}
                          >
                            <span>{u.name}</span>
                            {u.role === 'admin' && (
                              <Crown className="w-3 h-3 shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>

                    {targetTeam && (
                      <div className="space-y-4">
                        {/* Profile, Rank & Points Adjustment */}
                        <div className="p-3.5 rounded-xl bg-[#0E111A] border border-slate-800 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                              Team Profile &amp; Standings Adjustment
                            </span>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() =>
                                  handleAdminTeamAction(
                                    {
                                      action: 'update_profile',
                                      targetUserId: targetTeam.id,
                                      role:
                                        targetTeam.role === 'admin'
                                          ? 'member'
                                          : 'admin',
                                    },
                                    `${targetTeam.name} role changed to ${
                                      targetTeam.role === 'admin'
                                        ? 'Member'
                                        : 'League Admin'
                                    }.`
                                  )
                                }
                                className="min-h-[32px] px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-bold text-[#FFD100] cursor-pointer"
                              >
                                {targetTeam.role === 'admin'
                                  ? 'Demote to Member'
                                  : 'Promote to Admin'}
                              </button>
                              {targetTeam.id !== activeManagerId && (
                                <button
                                  onClick={() =>
                                    handleAdminTeamAction(
                                      {
                                        action: 'delete_team',
                                        targetUserId: targetTeam.id,
                                      },
                                      `Removed team ${targetTeam.name} from the league.`
                                    )
                                  }
                                  className="min-h-[32px] px-2.5 py-1 rounded-lg bg-red-500/15 border border-red-500/40 text-[11px] font-bold text-red-300 hover:bg-red-500/25 flex items-center gap-1 cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  <span>Remove Team</span>
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                            <div>
                              <label className="block text-[10px] font-mono text-slate-400 mb-1">
                                TEAM NAME
                              </label>
                              <input
                                type="text"
                                value={adminEditName}
                                onChange={(e) => setAdminEditName(e.target.value)}
                                className="w-full min-h-[38px] bg-[#131722] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-mono text-slate-400 mb-1">
                                PRIOR YEAR RANK (DRAFT ORDER)
                              </label>
                              <input
                                type="number"
                                min={1}
                                value={adminEditRank}
                                onChange={(e) =>
                                  setAdminEditRank(Number(e.target.value) || 1)
                                }
                                className="w-full min-h-[38px] bg-[#131722] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-mono text-slate-400 mb-1">
                                CUMULATIVE PRIOR / BONUS PTS
                              </label>
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() =>
                                    setAdminEditPriorPts((p) => p - 10)
                                  }
                                  className="min-h-[38px] px-2.5 rounded-lg bg-slate-800 text-xs font-mono font-bold text-slate-200 cursor-pointer"
                                >
                                  -10
                                </button>
                                <input
                                  type="number"
                                  value={adminEditPriorPts}
                                  onChange={(e) =>
                                    setAdminEditPriorPts(
                                      Number(e.target.value) || 0
                                    )
                                  }
                                  className="w-full min-h-[38px] bg-[#131722] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                                />
                                <button
                                  onClick={() =>
                                    setAdminEditPriorPts((p) => p + 10)
                                  }
                                  className="min-h-[38px] px-2.5 rounded-lg bg-slate-800 text-xs font-mono font-bold text-slate-200 cursor-pointer"
                                >
                                  +10
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="flex justify-end">
                            <button
                              onClick={() =>
                                handleAdminTeamAction(
                                  {
                                    action: 'update_profile',
                                    targetUserId: targetTeam.id,
                                    name: adminEditName,
                                    lastYearRank: adminEditRank,
                                    cumulativePriorPoints: adminEditPriorPts,
                                  },
                                  `Updated ${adminEditName}'s profile & points adjustment.`
                                )
                              }
                              className="min-h-[36px] px-4 py-1.5 rounded-xl bg-[#FFD100] text-black text-xs font-bold cursor-pointer"
                            >
                              Save Team Details
                            </button>
                          </div>
                        </div>

                        {/* Weekly Pick Override (Bypasses Lock & Usage Caps) */}
                        <div className="p-3.5 rounded-xl bg-[#0E111A] border border-slate-800 space-y-2.5">
                          <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-slate-300">
                              Override Weekly Starters ({targetTeam.name})
                            </div>
                            <div className="text-[11px] text-slate-400">
                              Change a team&apos;s starter for this weekend even if the Green Flag already dropped or driver usage cap was hit.
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                            {([1, 2, 3] as SeriesId[]).map((sId) => {
                              const raceObj = weekendRacesBySeries[sId];
                              const currentPick = (
                                leagueState?.weeklyPicks || []
                              ).find(
                                (p) =>
                                  p.userId === targetTeam.id &&
                                  p.raceId === raceObj?.id
                              );
                              const seriesDrivers = (
                                leagueState?.drivers || []
                              ).filter((d) => d.seriesId === sId);

                              return (
                                <div
                                  key={sId}
                                  className="p-2.5 rounded-xl bg-[#131722] border border-slate-800 space-y-1.5"
                                >
                                  <div className="flex items-center justify-between text-[11px]">
                                    <span className="font-bold text-white">
                                      {SERIES_META[sId].shortName}
                                    </span>
                                    <span className="font-mono text-slate-400">
                                      {raceObj?.isLockedRevealed ? 'LOCKED' : 'OPEN'}
                                    </span>
                                  </div>
                                  <select
                                    value={currentPick?.driverId || ''}
                                    onChange={(e) => {
                                      if (!raceObj || !e.target.value) return;
                                      handleAdminTeamAction(
                                        {
                                          action: 'override_weekly_pick',
                                          targetUserId: targetTeam.id,
                                          raceId: raceObj.id,
                                          seriesId: sId,
                                          driverId: e.target.value,
                                        },
                                        `Overrode ${targetTeam.name}'s ${SERIES_META[sId].shortName} weekly pick.`
                                      );
                                    }}
                                    className="w-full min-h-[36px] bg-[#090A0F] border border-slate-700 rounded-lg px-2 py-1 text-xs text-white"
                                  >
                                    <option value="">-- Unassigned --</option>
                                    {seriesDrivers.map((d) => (
                                      <option key={d.id} value={d.id}>
                                        #{d.carNumber} {d.fullName}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Season Roster & Car Anchor Override */}
                        <div className="p-3.5 rounded-xl bg-[#0E111A] border border-slate-800 space-y-2.5">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <div>
                              <div className="text-xs font-bold uppercase tracking-wider text-slate-300">
                                Override Season Roster &amp; Car Anchors ({targetTeam.name})
                              </div>
                              <div className="text-[11px] text-slate-400">
                                Reassign any exclusive season driver or tweak Car Anchor # if a mid-season driver swap happens.
                              </div>
                            </div>
                            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={adminForceReassign}
                                onChange={(e) =>
                                  setAdminForceReassign(e.target.checked)
                                }
                                className="rounded accent-[#FFD100]"
                              />
                              <span>Force steal if locked by another team</span>
                            </label>
                          </div>

                          <div className="space-y-2">
                            {seasonSlotDefs.map((slot) => {
                              const currentRow = (
                                leagueState?.seasonRosters || []
                              ).find(
                                (r) =>
                                  r.userId === targetTeam.id &&
                                  r.slotType === slot.slotType
                              );
                              const eligibleDrivers = (
                                leagueState?.drivers || []
                              ).filter(
                                (d) =>
                                  d.seriesId === slot.seriesId &&
                                  !d.isBuschwhacker &&
                                  slot.filter(d)
                              );
                              const anchorVal =
                                adminAnchorDrafts[slot.slotType] ??
                                currentRow?.fallbackCarNumber ??
                                '';

                              return (
                                <div
                                  key={slot.slotType}
                                  className="p-2.5 rounded-xl bg-[#131722] border border-slate-800 grid grid-cols-1 sm:grid-cols-12 gap-2 items-center"
                                >
                                  <div className="sm:col-span-3 text-xs font-bold text-slate-200">
                                    {slot.label}
                                  </div>
                                  <div className="sm:col-span-5">
                                    <select
                                      value={currentRow?.driverId || ''}
                                      onChange={(e) => {
                                        const chosen = eligibleDrivers.find(
                                          (d) => d.id === e.target.value
                                        );
                                        if (!chosen) return;
                                        handleAdminTeamAction(
                                          {
                                            action: 'override_season_slot',
                                            targetUserId: targetTeam.id,
                                            seriesId: slot.seriesId,
                                            slotType: slot.slotType,
                                            driverId: chosen.id,
                                            fallbackCarNumber:
                                              anchorVal || chosen.carNumber,
                                            forceReassign: adminForceReassign,
                                          },
                                          `Updated ${targetTeam.name}'s ${slot.label} to #${chosen.carNumber} ${chosen.fullName}.`
                                        );
                                      }}
                                      className="w-full min-h-[36px] bg-[#090A0F] border border-slate-700 rounded-lg px-2 py-1 text-xs text-white"
                                    >
                                      <option value="">-- Unassigned --</option>
                                      {eligibleDrivers.map((d) => (
                                        <option key={d.id} value={d.id}>
                                          #{d.carNumber} {d.fullName}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <div className="sm:col-span-2 flex items-center gap-1">
                                    <span className="text-[10px] font-mono text-slate-400">
                                      Car#
                                    </span>
                                    <input
                                      type="text"
                                      value={anchorVal}
                                      onChange={(e) =>
                                        setAdminAnchorDrafts((prev) => ({
                                          ...prev,
                                          [slot.slotType]: e.target.value,
                                        }))
                                      }
                                      className="w-full min-h-[36px] bg-[#090A0F] border border-slate-700 rounded-lg px-2 py-1 text-xs font-mono text-white"
                                    />
                                  </div>
                                  <div className="sm:col-span-2 flex justify-end">
                                    <button
                                      disabled={!currentRow?.driverId}
                                      onClick={() => {
                                        if (!currentRow?.driverId) return;
                                        handleAdminTeamAction(
                                          {
                                            action: 'override_season_slot',
                                            targetUserId: targetTeam.id,
                                            seriesId: slot.seriesId,
                                            slotType: slot.slotType,
                                            driverId: currentRow.driverId,
                                            fallbackCarNumber:
                                              anchorVal || '88',
                                            forceReassign: adminForceReassign,
                                          },
                                          `Saved Car Anchor #${anchorVal || '88'} for ${targetTeam.name}'s ${slot.label}.`
                                        );
                                      }}
                                      className={`w-full sm:w-auto min-h-[36px] px-3 py-1 rounded-lg text-[11px] font-bold ${
                                        currentRow?.driverId
                                          ? 'bg-slate-800 hover:bg-slate-700 text-[#FFD100] cursor-pointer'
                                          : 'bg-slate-900 text-slate-600 cursor-not-allowed'
                                      }`}
                                    >
                                      Save Anchor
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Commissioner Rules Toggles */}
              <div className="bg-[#131722] border border-slate-800/90 rounded-2xl p-4 space-y-3">
                <h2 className="font-display text-lg font-bold tracking-wide uppercase text-white">
                  Commissioner Scoring &amp; League Rules
                </h2>

                <div className="divide-y divide-slate-800/80 text-xs">
                  <div className="py-2.5 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-bold text-white">
                        Use Car Owner Points if Season Driver Misses Race (Car Anchor)
                      </div>
                      <div className="text-slate-400">
                        Awards substitute driver&apos;s Owner Points in the anchored car (e.g. #88) if your Season Driver is injured/DNS.
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        handleUpdateAdminSetting({
                          useCarAnchorFallback: !useCarAnchorFallback,
                        })
                      }
                      className={`min-h-[36px] px-3 py-1.5 rounded-lg font-bold cursor-pointer shrink-0 ${
                        useCarAnchorFallback
                          ? 'bg-emerald-500 text-black'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {useCarAnchorFallback ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>

                  <div className="py-2.5 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-bold text-white">
                        1st Place Vehicle / Owner Points Scale
                      </div>
                      <div className="text-slate-400">
                        Choose 55 pts or 40 pts for 1st place when calculating Buschwhacker Owner Points.
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        handleUpdateAdminSetting({
                          firstPlacePoints: firstPlacePoints === 55 ? 40 : 55,
                        })
                      }
                      className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#1D2233] border border-slate-700 font-mono font-bold text-[#FFD100] cursor-pointer shrink-0"
                    >
                      {firstPlacePoints} PTS (1st)
                    </button>
                  </div>

                  <div className="py-2.5 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-bold text-white">
                        5th Roster Slot: Mid-Season Cup Chase Bonus Pick
                      </div>
                      <div className="text-slate-400">
                        Unlocks for the final 10 Cup Chase races (duplicates allowed across league members).
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        handleUpdateAdminSetting({
                          chaseActive: !midSeasonChaseActive,
                        })
                      }
                      className={`min-h-[36px] px-3 py-1.5 rounded-lg font-bold cursor-pointer shrink-0 ${
                        midSeasonChaseActive
                          ? 'bg-[#FFD100] text-black'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {midSeasonChaseActive ? 'Unlocked' : 'Locked'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Compact Buschwhacker Owner Points Audit List */}
              <div className="bg-[#131722] border border-slate-800/90 rounded-2xl p-4 space-y-2.5">
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-lg font-bold tracking-wide uppercase text-white">
                    Live Buschwhacker &amp; Owner Points Telemetry Audit
                  </h2>
                  <span className="font-mono text-[11px] text-slate-400">
                    {cdnSchedulesSummary.cup} Cup ·{' '}
                    {cdnSchedulesSummary.oreillys} ORL ·{' '}
                    {cdnSchedulesSummary.trucks} TRK
                  </span>
                </div>

                <div className="space-y-1.5">
                  {[
                    ...computedWeekendResults[2]
                      .slice(0, 3)
                      .map((r) => ({ ...r, sId: 2 as SeriesId })),
                    ...computedWeekendResults[3]
                      .slice(0, 2)
                      .map((r) => ({ ...r, sId: 3 as SeriesId })),
                  ].map((row, i) => (
                    <div
                      key={i}
                      className="p-2.5 rounded-xl bg-[#0E111A] border border-slate-800/80 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold ${SERIES_META[row.sId].pylonBg}`}
                        >
                          #{row.actual_car_number}
                        </span>
                        <div className="min-w-0">
                          <div className="font-bold text-white truncate">
                            {row.driver_fullname} (P{row.finish_position})
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono truncate">
                            NASCAR Pts: {row.driver_points} · Calc Owner Pts:{' '}
                            {row.calculated_owner_points}
                          </div>
                        </div>
                      </div>
                      <div className="text-right font-mono shrink-0">
                        <div className="font-bold text-emerald-400">
                          {row.effective_fantasy_points} PTS
                        </div>
                        <div className="text-[10px] text-[#FFD100]">
                          {row.scoring_source === 'BUSCHWHACKER_OWNER_PTS'
                            ? 'OWNER PTS'
                            : 'OFFICIAL'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>

        {/* ==========================================
            SLEEPER-STYLE BOTTOM SHEET: SWAP WEEKLY STARTER
        ========================================== */}
        {swapWeeklyDrawerSeries !== null && (
          <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-end md:items-center justify-center p-0 md:p-4">
            <div className="w-full max-w-lg bg-[#131722] border-t md:border border-slate-700 rounded-t-3xl md:rounded-2xl max-h-[82vh] flex flex-col overflow-hidden">
              <div className="px-4 py-3 bg-[#181D2B] border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h3 className="font-display text-lg font-bold tracking-wide text-white">
                    Select {SERIES_META[swapWeeklyDrawerSeries].name} Starter
                  </h3>
                  <p className="text-xs text-slate-400">
                    Max 5 uses per driver per season · Buschwhackers score full Owner Points
                  </p>
                </div>
                <button
                  onClick={() => setSwapWeeklyDrawerSeries(null)}
                  className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-slate-800/80 p-2">
                {(leagueState?.drivers || [])
                  .filter((d) => d.seriesId === swapWeeklyDrawerSeries)
                  .map((d) => {
                    const usage = getDriverRemainingUses(
                      d.id,
                      swapWeeklyDrawerSeries
                    );
                    const isDepleted =
                      usage.remaining === 0 && !usage.isCurrentlyPicked;
                    const liveRes = computedWeekendResults[
                      swapWeeklyDrawerSeries
                    ].find((r) => r.nascar_driver_id === d.nascarDriverId);

                    return (
                      <div
                        key={d.id}
                        className="p-2.5 flex items-center justify-between gap-2.5 hover:bg-[#191F2E] rounded-xl"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`w-9 h-9 rounded-lg font-display font-bold text-base flex items-center justify-center shrink-0 ${SERIES_META[swapWeeklyDrawerSeries].pylonBg}`}
                          >
                            #{d.carNumber}
                          </div>
                          <div className="min-w-0">
                            <div className="font-bold text-sm text-white truncate">
                              {d.fullName}
                            </div>
                            <div className="text-[11px] text-slate-400 font-mono">
                              {usage.remaining}/{usage.maxUses} Uses Left ·{' '}
                              {liveRes
                                ? `${liveRes.effective_fantasy_points} Pts (P${liveRes.finish_position})`
                                : d.team}
                            </div>
                          </div>
                        </div>

                        <button
                          disabled={isDepleted}
                          onClick={() =>
                            handleSelectWeeklyPick(swapWeeklyDrawerSeries, d.id)
                          }
                          className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer shrink-0 ${
                            usage.isCurrentlyPicked
                              ? 'bg-emerald-500 text-black'
                              : isDepleted
                              ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                              : 'bg-[#FFD100] text-black hover:bg-[#ffe033]'
                          }`}
                        >
                          {usage.isCurrentlyPicked
                            ? 'ACTIVE'
                            : isDepleted
                            ? '0 LEFT'
                            : 'SELECT'}
                        </button>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        )}

        {/* ==========================================
            SLEEPER-STYLE BOTTOM SHEET: EDIT SEASON ROSTER SLOT
        ========================================== */}
        {swapSeasonDrawerSlot !== null && (
          <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-end md:items-center justify-center p-0 md:p-4">
            <div className="w-full max-w-lg bg-[#131722] border-t md:border border-slate-700 rounded-t-3xl md:rounded-2xl max-h-[82vh] flex flex-col overflow-hidden">
              <div className="px-4 py-3 bg-[#181D2B] border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h3 className="font-display text-lg font-bold tracking-wide text-white">
                    Draft / Edit Season Slot: {swapSeasonDrawerSlot.label}
                  </h3>
                  <p className="text-xs text-slate-400">
                    {swapSeasonDrawerSlot.exclusive
                      ? 'Exclusive Slot: Drivers owned by other managers are locked.'
                      : '5th Mid-Season Chase Bonus: Duplicates allowed across league!'}
                  </p>
                </div>
                <button
                  onClick={() => setSwapSeasonDrawerSlot(null)}
                  className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto divide-y divide-slate-800/80 p-2">
                {(leagueState?.drivers || [])
                  .filter((d) => {
                    if (
                      d.seriesId !== swapSeasonDrawerSlot.seriesId ||
                      d.isBuschwhacker
                    )
                      return false;
                    if (swapSeasonDrawerSlot.slotType === 'cup_prev_chase')
                      return d.madeLastYearChase;
                    if (swapSeasonDrawerSlot.slotType === 'cup_prev_non_chase')
                      return !d.madeLastYearChase;
                    if (swapSeasonDrawerSlot.slotType === 'cup_current_chase')
                      return d.inCurrentChase;
                    return true;
                  })
                  .map((d) => {
                    const lockedByRival = swapSeasonDrawerSlot.exclusive
                      ? (leagueState?.seasonRosters || []).find(
                          (r) =>
                            r.seriesId === swapSeasonDrawerSlot.seriesId &&
                            r.driverId === d.id &&
                            r.slotType !== 'cup_current_chase' &&
                            r.userId !== activeManagerId
                        )
                      : undefined;

                    const ownerName = lockedByRival
                      ? (leagueState?.users || []).find(
                          (u) => u.id === lockedByRival.userId
                        )?.name
                      : undefined;

                    return (
                      <div
                        key={d.id}
                        className="p-2.5 flex items-center justify-between gap-2.5 hover:bg-[#191F2E] rounded-xl"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`w-9 h-9 rounded-lg font-display font-bold text-base flex items-center justify-center shrink-0 ${SERIES_META[swapSeasonDrawerSlot.seriesId].pylonBg}`}
                          >
                            #{d.carNumber}
                          </div>
                          <div className="min-w-0">
                            <div className="font-bold text-sm text-white truncate">
                              {d.fullName}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {ownerName
                                ? `Locked by ${ownerName}`
                                : `${d.team} · Car Anchor #${d.carNumber}`}
                            </div>
                          </div>
                        </div>

                        <button
                          disabled={Boolean(lockedByRival)}
                          onClick={() =>
                            handleUpdateSeasonSlot(
                              swapSeasonDrawerSlot.seriesId,
                              swapSeasonDrawerSlot.slotType,
                              d.id,
                              d.carNumber
                            )
                          }
                          className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer shrink-0 ${
                            lockedByRival
                              ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                              : 'bg-[#FFD100] text-black hover:bg-[#ffe033]'
                          }`}
                        >
                          {lockedByRival ? 'LOCKED' : 'CLAIM'}
                        </button>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        )}

        {/* ==========================================
            JOIN LEAGUE / SIGN UP MODAL (Sleeper/ESPN Onboarding)
        ========================================== */}
        {showJoinModal && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-[#131722] border border-slate-700 rounded-2xl overflow-hidden shadow-2xl">
              <div className="h-1.5 w-full flex">
                <div className="flex-1 bg-[#FFD100]" />
                <div className="flex-1 bg-[#E4002B]" />
                <div className="flex-1 bg-[#1D63FF]" />
              </div>

              <div className="p-5 space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-display text-2xl font-bold tracking-wide text-white">
                      Join Pit Box Fantasy League
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Sign up with an Invite Code to create your team and auto-draft available season drivers, or sign in with Google.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowJoinModal(false)}
                    className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <form onSubmit={handleJoinLeagueSubmit} className="space-y-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-300 block mb-1">
                      Manager or Team Name
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g., Dale Jr. Motorsports"
                      value={newTeamName}
                      onChange={(e) => setNewTeamName(e.target.value)}
                      className="w-full min-h-[42px] bg-[#090A0F] border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#FFD100]"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-xs font-semibold text-slate-300 block mb-1">
                        League Invite Code
                      </label>
                      <input
                        type="text"
                        value={inviteCodeInput}
                        onChange={(e) => setInviteCodeInput(e.target.value)}
                        className="w-full min-h-[42px] bg-[#090A0F] border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono font-bold text-[#FFD100]"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-300 block mb-1">
                        Email (Optional)
                      </label>
                      <input
                        type="email"
                        placeholder="you@example.com"
                        value={newTeamEmail}
                        onChange={(e) => setNewTeamEmail(e.target.value)}
                        className="w-full min-h-[42px] bg-[#090A0F] border border-slate-700 rounded-xl px-3 py-2 text-xs text-white"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={isJoining}
                    className="w-full min-h-[44px] rounded-xl bg-[#FFD100] hover:bg-[#ffe033] text-black font-bold text-xs uppercase tracking-wider cursor-pointer transition-colors"
                  >
                    {isJoining
                      ? 'Creating Team & Roster...'
                      : 'Create Team & Enter League'}
                  </button>
                </form>

                <div className="relative flex py-1 items-center">
                  <div className="flex-grow border-t border-slate-800" />
                  <span className="shrink mx-3 text-[11px] text-slate-500">
                    OR LINK GOOGLE ACCOUNT
                  </span>
                  <div className="flex-grow border-t border-slate-800" />
                </div>

                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  className="w-full min-h-[42px] rounded-xl bg-[#1D2233] hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-white flex items-center justify-center gap-2 cursor-pointer"
                >
                  <LogIn className="w-4 h-4 text-[#FFD100]" />
                  <span>Continue with Google Sign-In</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* MOBILE BOTTOM NAVIGATION BAR (Compact 52px Sleeper-style Bar) */}
        <nav className="md:hidden fixed bottom-0 inset-x-0 h-13 bg-[#10131C]/95 backdrop-blur-md border-t border-slate-800/90 z-30 grid grid-cols-5 items-center px-1">
          {[
            { id: 'picks', label: 'My Lineup', icon: ShieldCheck },
            { id: 'standings', label: 'Scores', icon: Trophy },
            { id: 'bank', label: 'Drivers', icon: Database },
            { id: 'draft', label: 'Draft', icon: Users },
            { id: 'admin', label: 'League', icon: Sliders },
          ].map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id as any)}
                className={`min-h-[44px] flex flex-col items-center justify-center rounded-xl text-[10px] font-semibold tracking-tight cursor-pointer whitespace-nowrap shrink-0 ${
                  active ? 'text-[#FFD100]' : 'text-slate-400'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="mt-0.5">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
