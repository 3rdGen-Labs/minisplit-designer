import type { BomLine, Evaluation, Issue, IduPlacement, Severity, SystemDesign } from "../design";
import { iduById, num, oduById, type IndoorUnit, type OutdoorUnit } from "../catalog";

export interface Placed {
  p: IduPlacement;
  u: IndoorUnit;
}

/** Everything one rules pass needs, plus collectors for its output. */
export class Ctx {
  readonly issues: Issue[] = [];
  readonly bom: BomLine[] = [];
  readonly unchecked = new Set<string>();
  readonly placed: Placed[];
  readonly odu?: OutdoorUnit;
  /** Rated cooling per placement key, after MXZ combination-table substitution. */
  readonly ratedCooling = new Map<string, number>();
  /** Rated heating per placement key, after MXZ combination-table substitution. */
  readonly ratedHeating = new Map<string, number>();
  layout?: Evaluation["layout"];
  piping: NonNullable<Evaluation["piping"]> = [];
  charge?: Evaluation["charge"];
  a2l?: Evaluation["a2l"];
  assignments: NonNullable<Evaluation["assignments"]> = {};

  constructor(readonly design: SystemDesign) {
    this.odu = design.oduId != null ? oduById.get(design.oduId) : undefined;
    this.placed = design.idus.flatMap((p) => {
      const u = iduById.get(p.iduId);
      return u ? [{ p, u }] : [];
    });
    for (const { p, u } of this.placed) {
      this.ratedCooling.set(p.key, u.coolingBtu);
      this.ratedHeating.set(p.key, u.heatingBtu);
    }
  }

  issue(severity: Severity, code: string, message: string, target?: string) {
    this.issues.push({ severity, code, message, target });
  }
  error(code: string, message: string, target?: string) {
    this.issue("error", code, message, target);
  }
  /** An error that adding more units can clear, so the designer doesn't block an addition over it. */
  incomplete(code: string, message: string, target?: string) {
    this.issues.push({ severity: "error", code, message, target, incomplete: true });
  }
  warn(code: string, message: string, target?: string) {
    this.issue("warning", code, message, target);
  }
  info(code: string, message: string, target?: string) {
    this.issue("info", code, message, target);
  }

  add(line: BomLine) {
    this.bom.push(line);
  }

  /** Feet of equivalent length added per field bend (ODU column; DSB uses 0.984 ft on most MXZ/SM rows). */
  get bendEquivFt() {
    return num(this.odu?.raw.numBendEquivLength) || 0.984;
  }
  /** Equivalent length of an IDU's line: actual length plus bends. */
  eq(p: IduPlacement): number | undefined {
    return p.pipeLengthFt == null ? undefined : p.pipeLengthFt + (p.bends ?? 0) * this.bendEquivFt;
  }

  get sizeSum() {
    return this.placed.reduce((s, x) => s + x.u.size, 0);
  }
  get ratedSum() {
    return [...this.ratedCooling.values()].reduce((s, v) => s + v, 0);
  }
}

export const label = (x: Placed) => `${x.u.model} (${x.p.room})`;
export const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
