import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, Object3D, Vector3, type InstancedMesh } from 'three'
import { makeAvatarRigPose, type RigPoint } from './avatarRig'
import { type CrowdTier } from './agentStatus'
import type { Seat } from './officeLayout'
import { CHAIR_Z } from './officeMotion'
import type { OfficePreferences } from './officePreferences'
import type { OfficeSimulation } from './officeSimulation'

// All people retain the same world state when switching between detail levels.
// Far-view avatars keep only three tiers (WORKING/IDLE/BREAK); the full ten
// states live in the detailed scene and the labels.
export function OfficeCrowdLOD({ seats, theme, tiers, simulation, onSelect }: {
  seats: Seat[]; theme: OfficePreferences['theme']; tiers: ReadonlyMap<string, CrowdTier>
  simulation: RefObject<OfficeSimulation>; onSelect: (agentId: string) => void
}) {
  const tabletops = useRef<InstancedMesh>(null), deskLegs = useRef<InstancedMesh>(null)
  const chairs = useRef<InstancedMesh>(null), chairBacks = useRef<InstancedMesh>(null), monitors = useRef<InstancedMesh>(null)
  const torsos = useRef<InstancedMesh>(null), heads = useRef<InstancedMesh>(null), hair = useRef<InstancedMesh>(null)
  const arms = useRef<InstancedMesh>(null), legs = useRef<InstancedMesh>(null), shoes = useRef<InstancedMesh>(null)
  const cache = useRef(new Map<string, string>())
  const scratch = useMemo(() => ({ temp: new Object3D(), up: new Vector3(0, 1, 0), direction: new Vector3() }), [])
  const apply = useCallback((peopleOnly: boolean) => {
    const { temp, up, direction } = scratch
    let updated = false
    let furnitureChanged = !peopleOnly
    for (const [index, seat] of seats.entries()) {
      const actor = simulation.current.get(seat.agent.id)
      if (!actor) continue
      const state = actor.state
      const token = `${state.position}:${state.facing}:${state.seated}:${actor.gait}:${state.walking}`
      if (peopleOnly && cache.current.get(seat.agent.id) === token) continue
      const initialize = !peopleOnly || !cache.current.has(seat.agent.id)
      cache.current.set(seat.agent.id, token); updated = true
      const [x, , z] = seat.position
      const put = (mesh: InstancedMesh | null, px: number, py: number, pz: number, targetIndex = index,
        scale: [number, number, number] = [1, 1, 1], facing = 0) => {
        if (!mesh) return
        temp.position.set(px, py, pz); temp.rotation.set(0, facing, 0); temp.scale.set(...scale); temp.updateMatrix()
        mesh.setMatrixAt(targetIndex, temp.matrix)
      }
      const personX = state.position[0], personZ = state.position[1], c = Math.cos(state.facing), s = Math.sin(state.facing)
      const world = (point: RigPoint): RigPoint => [personX + point[0] * c + point[2] * s, point[1], personZ - point[0] * s + point[2] * c]
      const rig = makeAvatarRigPose(state.seated, state.walking, 0, tiers.get(seat.agent.id) === 'WORKING' ? 'coding' : 'idle', 0, actor.gait)
      const bone = (mesh: InstancedMesh | null, start: RigPoint, end: RigPoint, boneIndex: number) => {
        if (!mesh) return
        const a = world(start), b = world(end)
        direction.set(b[0] - a[0], b[1] - a[1], b[2] - a[2])
        const length = direction.length()
        temp.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
        temp.quaternion.setFromUnitVectors(up, direction.normalize()); temp.scale.set(1, length, 1); temp.updateMatrix()
        mesh.setMatrixAt(boneIndex, temp.matrix)
      }
      if (initialize) {
        furnitureChanged = true
        put(tabletops.current, x, .95, z - .22); put(chairs.current, x, .65, z + CHAIR_Z)
        put(chairBacks.current, x, 1.05, z + CHAIR_Z + .43); put(monitors.current, x, 1.58, z - .64)
        for (const [corner, dx, dz] of [[0, -1.04, -.66], [1, -1.04, .25], [2, 1.04, -.66], [3, 1.04, .25]]) put(deskLegs.current, x + dx, .48, z + dz, index * 4 + corner)
      }
      const body = world([0, 1.4 - rig.torsoDrop, -.045]), hairTop = world([0, 2.085 - rig.torsoDrop, -.018])
      put(torsos.current, ...body, index, [1, 1, 1], state.facing)
      put(heads.current, personX, 1.98 - rig.torsoDrop, personZ)
      put(hair.current, ...hairTop, index, [1, 1, 1], state.facing)
      for (let side = 0; side < 2; side++) {
        const arm = rig.arms[side], leg = rig.legs[side]
        bone(arms.current, arm.shoulder, arm.elbow, index * 4 + side * 2)
        bone(arms.current, arm.elbow, arm.wrist, index * 4 + side * 2 + 1)
        bone(legs.current, leg.hip, leg.knee, index * 4 + side * 2)
        bone(legs.current, leg.knee, leg.ankle, index * 4 + side * 2 + 1)
        put(shoes.current, ...world(leg.foot), index * 2 + side, [1, 1, 1], state.facing)
        if (initialize) {
          arms.current?.setColorAt(index * 4 + side * 2, new Color(seat.agent.color))
          arms.current?.setColorAt(index * 4 + side * 2 + 1, new Color('#dbad8c'))
        }
      }
      if (initialize) torsos.current?.setColorAt(index, new Color(seat.agent.color))
    }
    if (!updated) return
    for (const mesh of [...(furnitureChanged ? [tabletops.current, deskLegs.current, chairs.current, chairBacks.current, monitors.current] : []),
      torsos.current, heads.current, hair.current, arms.current, legs.current, shoes.current]) {
      if (!mesh) continue
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
    }
  }, [seats, tiers, simulation, scratch])
  useLayoutEffect(() => { cache.current.clear(); apply(false) }, [apply])
  useFrame(() => apply(true))
  if (!seats.length) return null
  const select = (event: { instanceId?: number; stopPropagation: () => void }) => {
    if (event.instanceId === undefined) return
    event.stopPropagation()
    const agent = seats[event.instanceId]?.agent
    if (agent) onSelect(agent.id)
  }
  return <group>
    <instancedMesh ref={tabletops} args={[undefined, undefined, seats.length]} receiveShadow>
      <boxGeometry args={[2.5, .16, 1.32]}/>
      <meshStandardMaterial color={theme === 'midnight' ? '#b8a28f' : '#e3e9f1'} roughness={.74}/>
    </instancedMesh>
    <instancedMesh ref={deskLegs} args={[undefined, undefined, seats.length * 4]}>
      <boxGeometry args={[.09, .92, .09]}/><meshStandardMaterial color="#596d83" metalness={.35}/>
    </instancedMesh>
    <instancedMesh ref={chairs} args={[undefined, undefined, seats.length]}>
      <boxGeometry args={[.8, .13, .82]}/><meshStandardMaterial color="#526b85"/>
    </instancedMesh>
    <instancedMesh ref={chairBacks} args={[undefined, undefined, seats.length]}>
      <boxGeometry args={[.86, .76, .13]}/><meshStandardMaterial color="#526b85"/>
    </instancedMesh>
    <instancedMesh ref={monitors} args={[undefined, undefined, seats.length]}>
      <boxGeometry args={[1.4, .87, .08]}/><meshStandardMaterial color="#25374c"/>
    </instancedMesh>
    <instancedMesh ref={torsos} args={[undefined, undefined, seats.length]} onClick={select}>
      <capsuleGeometry args={[.29, .12, 4, 8]}/><meshStandardMaterial roughness={.86}/>
    </instancedMesh>
    <instancedMesh ref={heads} args={[undefined, undefined, seats.length]} onClick={select}>
      <sphereGeometry args={[.275, 10, 8]}/><meshStandardMaterial color="#dbad8c" roughness={.86}/>
    </instancedMesh>
    <instancedMesh ref={hair} args={[undefined, undefined, seats.length]}>
      <sphereGeometry args={[.287, 12, 9, 0, Math.PI * 2, 0, Math.PI * .55]}/><meshStandardMaterial color="#354359" roughness={.9}/>
    </instancedMesh>
    <instancedMesh ref={arms} args={[undefined, undefined, seats.length * 4]}>
      <cylinderGeometry args={[.085, .095, 1, 7]}/><meshStandardMaterial roughness={.85}/>
    </instancedMesh>
    <instancedMesh ref={legs} args={[undefined, undefined, seats.length * 4]}>
      <cylinderGeometry args={[.125, .132, 1, 7]}/><meshStandardMaterial color="#273a55" roughness={.84}/>
    </instancedMesh>
    <instancedMesh ref={shoes} args={[undefined, undefined, seats.length * 2]}>
      <boxGeometry args={[.3, .146, .38]}/><meshStandardMaterial color="#233248" roughness={.9}/>
    </instancedMesh>
  </group>
}
