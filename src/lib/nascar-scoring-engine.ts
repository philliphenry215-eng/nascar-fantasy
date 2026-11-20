export interface NascarFeedResult {
  driver_id: number;
  driver_fullname: string;
  car_number: string;
  team_name?: string;
  finishing_position: number;
  points_earned: number; // 0 if declared for points in another series (Buschwhacker)
  finishing_status?: string;
  fastest_lap?: boolean;
}

export interface NascarStageFeed {
  stage_num: number;
  results: Array<{
    driver_id: number;
    car_number: string;
    stage_points: number; // 1st = 10 down to 10th = 1
  }>;
}

export interface ComputedRaceResult {
  nascar_driver_id: number;
  driver_fullname: string;
  actual_car_number: string;
  actual_team_name: string;
  finish_position: number;
  stage_points: number;
  fastest_lap_bonus: number;
  driver_points: number;
  calculated_owner_points: number;
  effective_fantasy_points: number;
  is_disqualified: boolean;
  scoring_source: 'OFFICIAL_DRIVER_PTS' | 'BUSCHWHACKER_OWNER_PTS' | 'DQ_PENALTY';
}

/**
 * Calculates Position Points per NASCAR Official Scale:
 * 1st = firstPlacePts (55 or 40 configurable in Admin), 2nd = 35, 3rd = 34 ... decreasing by 1 down to 36th-40th = 1 pt.
 * Disqualified vehicles receive 1 pt.
 */
export function calculatePositionOwnerPoints(
  finishPosition: number,
  firstPlaceConfig: 55 | 40 = 55,
  isDisqualified: boolean = false
): number {
  if (isDisqualified || finishPosition <= 0) return 1;
  if (finishPosition === 1) return firstPlaceConfig;
  if (finishPosition >= 2 && finishPosition <= 35) {
    return 37 - finishPosition; // 2nd = 35, 3rd = 34, ..., 35th = 2
  }
  return 1; // 36th through 40th = 1 pt
}

/**
 * Dual-Source Points Engine:
 * Evaluates reported `points_earned` vs calculated Vehicle/Owner Points.
 * Ensures Buschwhackers (e.g., Kyle Larson or Chase Elliott in O'Reilly's/Trucks)
 * and Ride-Swapping drivers always award full Owner Points instead of 0.
 */
export function processRaceResultsWithOwnerFallback(
  raceResults: NascarFeedResult[],
  stageFeeds: NascarStageFeed[],
  firstPlaceConfig: 55 | 40 = 55,
  fastestLapDriverId?: number
): ComputedRaceResult[] {
  const stagePointsByDriver = new Map<number, number>();
  const stagePointsByCar = new Map<string, number>();

  for (const stage of stageFeeds) {
    for (const row of stage.results || []) {
      const pts = Number(row.stage_points || 0);
      stagePointsByDriver.set(row.driver_id, (stagePointsByDriver.get(row.driver_id) || 0) + pts);
      stagePointsByCar.set(row.car_number, (stagePointsByCar.get(row.car_number) || 0) + pts);
    }
  }

  return raceResults.map((entry) => {
    const isDQ = (entry.finishing_status || '').toLowerCase().includes('disqualified');
    const stagePts =
      stagePointsByDriver.get(entry.driver_id) ??
      stagePointsByCar.get(entry.car_number) ??
      0;

    const fastestLapBonus =
      entry.fastest_lap || (fastestLapDriverId && entry.driver_id === fastestLapDriverId) ? 1 : 0;

    const positionOwnerPts = calculatePositionOwnerPoints(
      entry.finishing_position,
      firstPlaceConfig,
      isDQ
    );

    const calculatedOwnerPoints = isDQ
      ? 1
      : positionOwnerPts + stagePts + fastestLapBonus;

    const reportedDriverPoints = isDQ ? 1 : Number(entry.points_earned || 0);

    // Always credit MAX(driver_points, calculated_owner_points)
    const effectiveFantasyPoints = Math.max(reportedDriverPoints, calculatedOwnerPoints);

    let scoringSource: ComputedRaceResult['scoring_source'] = 'OFFICIAL_DRIVER_PTS';
    if (isDQ) {
      scoringSource = 'DQ_PENALTY';
    } else if (reportedDriverPoints === 0 && calculatedOwnerPoints > 0) {
      scoringSource = 'BUSCHWHACKER_OWNER_PTS';
    }

    return {
      nascar_driver_id: entry.driver_id,
      driver_fullname: entry.driver_fullname,
      actual_car_number: String(entry.car_number).replace('#', '').trim(),
      actual_team_name: entry.team_name || 'NASCAR Entry',
      finish_position: entry.finishing_position,
      stage_points: stagePts,
      fastest_lap_bonus: fastestLapBonus,
      driver_points: reportedDriverPoints,
      calculated_owner_points: calculatedOwnerPoints,
      effective_fantasy_points: effectiveFantasyPoints,
      is_disqualified: isDQ,
      scoring_source: scoringSource,
    };
  });
}

/**
 * Resolves Season-Long Roster Points including the "Car Anchor" Fallback
 * if a user's Season-Long driver misses the race due to injury/relief driver.
 */
export function resolveSeasonSlotScore(params: {
  primaryNascarDriverId: number;
  fallbackCarNumber: string;
  useCarAnchorFallback: boolean;
  raceResults: ComputedRaceResult[];
}): {
  points: number;
  badgeText: string;
  usedCarAnchor: boolean;
  actualCarNumber: string;
} {
  const { primaryNascarDriverId, fallbackCarNumber, useCarAnchorFallback, raceResults } = params;

  // 1. Check if the primary drafted driver started the race
  const primaryResult = raceResults.find((r) => r.nascar_driver_id === primaryNascarDriverId);
  if (primaryResult) {
    const isOwnerPts = primaryResult.scoring_source === 'BUSCHWHACKER_OWNER_PTS';
    return {
      points: primaryResult.effective_fantasy_points,
      badgeText: `${primaryResult.driver_fullname} (#${primaryResult.actual_car_number}) · ${primaryResult.effective_fantasy_points} ${isOwnerPts ? 'Owner Pts' : 'Pts'}`,
      usedCarAnchor: false,
      actualCarNumber: primaryResult.actual_car_number,
    };
  }

  // 2. Primary driver DNS (Injury/Suspension): Check Car Anchor Fallback if enabled
  if (useCarAnchorFallback) {
    const normalizedCar = fallbackCarNumber.replace('#', '').trim();
    const substituteResult = raceResults.find((r) => r.actual_car_number === normalizedCar);

    if (substituteResult) {
      return {
        points: substituteResult.calculated_owner_points,
        badgeText: `Car Anchor #${normalizedCar} (Sub: ${substituteResult.driver_fullname}) · ${substituteResult.calculated_owner_points} Owner Pts`,
        usedCarAnchor: true,
        actualCarNumber: substituteResult.actual_car_number,
      };
    }
  }

  return {
    points: 0,
    badgeText: `DNS (#${fallbackCarNumber}) · 0 Pts`,
    usedCarAnchor: false,
    actualCarNumber: fallbackCarNumber,
  };
}
