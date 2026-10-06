/**
 * String materials and the map from (material, diameter, length, tension) to the physical
 * constants that appear in the stiff-string equation.
 *
 * Plain strings are solid round wire: linear density mu = rho * pi d^2 / 4 and bending
 * stiffness EI = E * pi d^4 / 64.
 *
 * Wound strings carry their tension and bending stiffness in a steel core of diameter
 * d_core = coreRatio * d, while the wrap adds mass but (to first order) no stiffness. Their
 * linear density is written as rho_eff * pi d^2 / 4 with an effective density calibrated to
 * published unit weights (see `MATERIALS.wound.source`).
 */

export type MaterialId = 'steel' | 'nylon' | 'gut' | 'wound';

export interface Material {
  readonly id: MaterialId;
  readonly label: string;
  /** Young's modulus of the load-bearing part (the core for wound strings), Pa. */
  readonly youngsModulus: number;
  /** Density used for the linear mass (effective density over the outer diameter), kg/m^3. */
  readonly density: number;
  /** Core diameter as a fraction of the outer diameter (1 for plain strings). */
  readonly coreRatio: number;
  /** Ultimate tensile strength of the load-bearing part, Pa (used for the breaking-load hint). */
  readonly tensileStrength: number;
  /** Diameter range offered by the interface, m. */
  readonly diameterRange: readonly [number, number];
  /** Where the numbers come from (shown in the About / How it works panel). */
  readonly source: string;
}

export const MATERIALS: Readonly<Record<MaterialId, Material>> = {
  steel: {
    id: 'steel',
    label: 'Plain steel',
    // Music wire, ASTM A228.
    youngsModulus: 207e9,
    // D'Addario's published unit weights for plain steel (PL010, PL013, PL017) imply 7.80 g/cm^3.
    density: 7800,
    coreRatio: 1,
    tensileStrength: 2.5e9,
    diameterRange: [0.15e-3, 1.2e-3],
    source:
      "Music wire (ASTM A228), E = 207 GPa; density 7.80 g/cm³ from D'Addario unit weights (PL010: 0.00002215 lb/in).",
  },
  nylon: {
    id: 'nylon',
    label: 'Nylon',
    // Bending modulus at zero stress; it rises with tension (see `effectiveModulus`).
    youngsModulus: 4.5e9,
    density: 1140,
    coreRatio: 1,
    tensileStrength: 0.45e9,
    diameterRange: [0.4e-3, 1.6e-3],
    source:
      'Nylon 6,6, density 1.14 g/cm³; bending modulus E = 4.5 GPa + 39 σ, rising with the tensile stress σ (Woodhouse & Lynch-Aird, Acta Acustica 2019).',
  },
  gut: {
    id: 'gut',
    label: 'Gut',
    youngsModulus: 6.0e9,
    density: 1320,
    coreRatio: 1,
    tensileStrength: 0.4e9,
    diameterRange: [0.4e-3, 2.0e-3],
    source:
      'Natural gut, density 1.32 g/cm³, E = 6.0 GPa (Woodhouse & Lynch-Aird, Acta Acustica 2019).',
  },
  wound: {
    id: 'wound',
    label: 'Wound steel',
    youngsModulus: 207e9,
    // Calibrated to D'Addario NW046 (0.046 in, 0.00038216 lb/in): mu / (pi d^2 / 4) = 6.37 g/cm^3.
    density: 6370,
    // Chosen so a 0.046 in E2 at standard tension has B = 1.47e-4, close to the 1.56e-4 measured on
    // electric guitars (Barbancho et al., IEEE TASLP 2012).
    coreRatio: 0.4,
    tensileStrength: 2.5e9,
    diameterRange: [0.6e-3, 6.5e-3],
    source:
      "Steel core (40 % of the outer diameter) carries the tension and the bending stiffness; the wrap only adds mass. Effective density calibrated to D'Addario NW046.",
  },
};

export const MATERIAL_IDS: readonly MaterialId[] = ['steel', 'nylon', 'gut', 'wound'];

/** Everything needed to build a string. Lengths in metres, forces in newtons. */
export interface StringParams {
  /** Vibrating length L, m. */
  length: number;
  /** Tension T, N. */
  tension: number;
  material: MaterialId;
  /** Outer diameter d, m. */
  diameter: number;
  /** Frequency-independent loss sigma_0, 1/s. */
  sigma0: number;
  /** Frequency-dependent loss sigma_1, m^2/s. */
  sigma1: number;
  /**
   * Optional inharmonicity override. When set, the bending stiffness EI is chosen so that
   * B = pi^2 EI / (T L^2) equals this value, instead of coming from the material.
   */
  inharmonicity?: number | null;
  /** Optional construction overrides (presets such as a piano bass string). */
  coreRatio?: number;
  density?: number;
  youngsModulus?: number;
}

/** Physical constants derived from `StringParams`. */
export interface StringPhysics {
  /** Linear density mu = rho A, kg/m. */
  mu: number;
  /** Bending stiffness E I, N m^2. */
  EI: number;
  /** Transverse wave speed c = sqrt(T / mu), m/s. */
  c: number;
  /** Stiffness parameter kappa = sqrt(EI / mu), m^2/s. */
  kappa: number;
  /** Ideal-string fundamental f0 = c / (2 L), Hz. */
  f0: number;
  /** Inharmonicity coefficient B = pi^2 EI / (T L^2) (= pi^3 E d^4 / (64 T L^2) for solid wire). */
  B: number;
  /** Inharmonicity implied by the material alone (before any override). */
  materialB: number;
  /** Load at which the load-bearing part reaches its tensile strength, N. */
  breakingLoad: number;
  /** Core diameter actually used for stiffness, m. */
  coreDiameter: number;
}

export function materialOf(params: StringParams): Material {
  return MATERIALS[params.material];
}

/** Linear density mu (kg/m) for a material and outer diameter. */
export function linearDensity(params: Pick<StringParams, 'material' | 'diameter' | 'density'>) {
  const m = MATERIALS[params.material];
  const rho = params.density ?? m.density;
  return (rho * Math.PI * params.diameter * params.diameter) / 4;
}

/**
 * Young's modulus used for bending. Polymer strings stiffen under load: for nylon the bending
 * modulus measured by Woodhouse & Lynch-Aird (2019) is E = 4.5 GPa + 39 sigma, sigma being the
 * tensile stress T / A. Metals and gut use a constant modulus.
 */
export function effectiveModulus(params: StringParams): number {
  const m = MATERIALS[params.material];
  if (params.youngsModulus != null) return params.youngsModulus;
  if (m.id === 'nylon') {
    const area = (Math.PI * params.diameter * params.diameter) / 4;
    return m.youngsModulus + 39 * (params.tension / area);
  }
  return m.youngsModulus;
}

export function deriveString(params: StringParams): StringPhysics {
  const m = MATERIALS[params.material];
  const coreRatio = params.coreRatio ?? m.coreRatio;
  const dCore = coreRatio * params.diameter;
  const mu = linearDensity(params);
  const I = (Math.PI * dCore ** 4) / 64;
  const { length: L, tension: T } = params;
  const materialEI = effectiveModulus(params) * I;
  const materialB = (Math.PI * Math.PI * materialEI) / (T * L * L);
  const override = params.inharmonicity;
  const B = override != null && Number.isFinite(override) ? Math.max(0, override) : materialB;
  const EI = (B * T * L * L) / (Math.PI * Math.PI);
  const c = Math.sqrt(T / mu);
  return {
    mu,
    EI,
    c,
    kappa: Math.sqrt(EI / mu),
    f0: c / (2 * L),
    B,
    materialB,
    breakingLoad: (m.tensileStrength * Math.PI * dCore * dCore) / 4,
    coreDiameter: dCore,
  };
}

/** Tension (N) that tunes a string of linear density mu and length L to frequency f. */
export function tensionForFrequency(mu: number, length: number, frequency: number): number {
  const v = 2 * length * frequency;
  return mu * v * v;
}

/** Closed form for solid round wire, B = pi^3 E d^4 / (64 T L^2) (Fletcher 1964). */
export function inharmonicitySolidWire(E: number, d: number, T: number, L: number): number {
  return (Math.PI ** 3 * E * d ** 4) / (64 * T * L * L);
}
