/**
 * MODULE: simulation — stats helpers (module-internal API; may change).
 * Owner: simulation agent.
 */
import { START_MONEY, type BudgetReport, type CityStats, type ServiceCoverage } from '../types';

export function emptyCoverage(): ServiceCoverage {
  return { police: 0, fire: 0, education: 0, health: 0 };
}

/** An all-zero budget report. */
export function emptyBudget(): BudgetReport {
  return {
    taxes: { r: 0, c: 0, i: 0 },
    other: 0,
    roadUpkeep: 0,
    parkUpkeep: 0,
    serviceUpkeep: 0,
    income: 0,
    expenses: 0,
    net: 0,
  };
}

/** Neutral stats for an empty city on day 0. */
export function emptyStats(money = START_MONEY): CityStats {
  return {
    day: 0,
    money,
    population: 0,
    workforce: 0,
    jobsCommercial: 0,
    jobsIndustrial: 0,
    jobsTotal: 0,
    employed: 0,
    unemployment: 0,
    demand: { r: 0, c: 0, i: 0 },
    zonedTiles: { r: 0, c: 0, i: 0 },
    buildings: { r: 0, c: 0, i: 0 },
    abandoned: 0,
    roadTiles: 0,
    parkTiles: 0,
    landValueAvg: 0,
    pollutionAvg: 0,
    happiness: 0.5,
    civics: { town_hall: 0, police: 0, fire: 0, school: 0, hospital: 0 },
    coverage: emptyCoverage(),
    lastMonth: emptyBudget(),
    projected: emptyBudget(),
  };
}
