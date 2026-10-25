/**
 * FROZEN CONTRACT — uniforms shared by materials across modules.
 * Owner: integrator. Module agents MUST NOT edit this file.
 *
 * Writer: src/render/scene.ts (ISceneContext.update) — the ONLY module that assigns `.value`.
 * Readers: any material, by reference, e.g. inside onBeforeCompile:
 *     shader.uniforms.uNight = sharedUniforms.uNight;
 * Because the same object is shared, value updates propagate to every material automatically.
 */
export interface FloatUniform {
  value: number;
}

export const sharedUniforms: {
  /** Seconds since start (monotonic, keeps running while the sim is paused). */
  readonly uTime: FloatUniform;
  /** 0 = full day … 1 = full night. Drives emissive window/lamp/sign glow (see blocks.ts). */
  readonly uNight: FloatUniform;
  /** 0..1 sun elevation factor (0 below horizon, 1 at zenith); optional use for water/sky shading. */
  readonly uSun: FloatUniform;
} = {
  uTime: { value: 0 },
  uNight: { value: 0 },
  uSun: { value: 1 },
};
