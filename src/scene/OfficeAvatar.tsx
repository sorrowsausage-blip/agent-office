import { RoundedBox } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useRef, type RefObject } from 'react'
import { MathUtils, Vector3, type Group, type Mesh } from 'three'
import type { OfficeAgent } from '../types'
import type { AgentPose } from './agentBehavior'
import { makeAvatarRigPose, type RigPoint } from './avatarRig'
import type { BreakActivity } from './officeMotion'

const UP = new Vector3(0, 1, 0)
const BONE_START = new Vector3()
const BONE_DIRECTION = new Vector3()

// Every animated limb is a continuous joint-to-joint bone. Connecting the
// segments to the same elbow/knee coordinates prevents floating hands and gaps.
function fitBone(mesh: Mesh | undefined, start: RigPoint, end: RigPoint) {
  if (!mesh) return
  const a = BONE_START.set(...start)
  const direction = BONE_DIRECTION.set(...end).sub(a)
  const length = direction.length()
  mesh.position.copy(a.addScaledVector(direction, .5))
  mesh.quaternion.setFromUnitVectors(UP, direction.normalize())
  mesh.scale.y = length
}

export function OfficeAvatar({ agent, pose, selected, onSelect, walkRef, gaitRef, seatedRef, coffeeRef, animate = true, breakActivityRef }: {
  agent: OfficeAgent; pose: AgentPose; selected: boolean; onSelect: () => void
  walkRef: RefObject<number>; gaitRef: RefObject<number>; seatedRef: RefObject<number>; coffeeRef: RefObject<boolean>
  animate?: boolean; breakActivityRef?: RefObject<BreakActivity>
}) {
  const model = useRef<Group>(null)
  const torso = useRef<Group>(null)
  const head = useRef<Group>(null)
  const upperArms = useRef<Mesh[]>([])
  const lowerArms = useRef<Mesh[]>([])
  const hands = useRef<Group[]>([])
  const elbows = useRef<Mesh[]>([])
  const thighs = useRef<Mesh[]>([])
  const shins = useRef<Mesh[]>([])
  const knees = useRef<Mesh[]>([])
  const shoes = useRef<Mesh[]>([])
  const halo = useRef<Mesh>(null)
  const coffeeCup = useRef<Group>(null)
  const coffeeBlend = useRef(0)
  const coffeeTime = useRef(0)
  const thinkingBlend = useRef(0)
  const walkBlend = useRef(0)
  const skin = agent.id === 'sentinel' ? '#c48c70' : agent.id === 'pixel' ? '#efc8ab' : '#dbad8c'
  const hair = agent.id === 'nova' ? '#2b4058' : agent.id === 'pixel' ? '#894f47' : agent.id === 'sentinel' ? '#41332f' : '#282b43'
  // OFFLINE reads as grey and still: the scene also passes animate={false}
  // for offline agents, so the rig freezes with the desaturated colours.
  const displayColor = pose === 'offline' ? '#7d8794' : agent.color

  useFrame(({ clock }, delta) => {
    const t = animate ? clock.elapsedTime : 0
    // Break activities are decoration driven by the movement state: the
    // task pose (coding, thinking, collaborating, …) always wins, and an
    // activity only re-shapes the upper body while the agent is parked.
    const breakActivity = breakActivityRef?.current ?? 'none'
    thinkingBlend.current = MathUtils.damp(thinkingBlend.current, pose === 'thinking' || breakActivity === 'think' || breakActivity === 'daydream' ? 1 : 0, 4, Math.min(delta, .05))
    walkBlend.current = MathUtils.damp(walkBlend.current, walkRef.current, 8, Math.min(delta, .05))
    coffeeBlend.current = MathUtils.damp(coffeeBlend.current, coffeeRef.current ? 1 : 0, 5, Math.min(delta, .05))
    coffeeTime.current = coffeeRef.current ? coffeeTime.current + Math.min(delta, .05) : 0
    if (coffeeCup.current) { coffeeCup.current.visible = coffeeBlend.current > .2; coffeeCup.current.rotation.x = -.18 * (.5 - .5 * Math.cos(coffeeTime.current * 1.35)) }
    // 'pace' steps in place at the window: the gait advances on the clock,
    // not on distance travelled, and the body never leaves its spot.
    const gaitPhase = breakActivity === 'pace' ? t * 5 : gaitRef.current
    const rigActivity = breakActivity === 'read' ? 'reading' : breakActivity === 'nap' ? 'napping' : breakActivity === 'pour' ? 'pouring'
      : breakActivity === 'gaze' ? 'researching' : breakActivity === 'think' || breakActivity === 'daydream' ? 'thinking' : pose
    const rig = makeAvatarRigPose(seatedRef.current, walkBlend.current, t, rigActivity, thinkingBlend.current, gaitPhase, coffeeBlend.current, coffeeTime.current)
    // Breathing moves the upper body, never lifts the planted shoes off the floor.
    if (model.current) model.current.position.y = 0
    if (torso.current) {
      torso.current.position.y = -rig.torsoDrop + rig.bob
      torso.current.rotation.x = MathUtils.damp(torso.current.rotation.x, pose === 'error' ? .1 : 0, 7, Math.min(delta, .05))
    }
    if (head.current) {
      head.current.rotation.x = MathUtils.damp(head.current.rotation.x, rig.headPitch, 7, Math.min(delta, .05))
      head.current.rotation.z = MathUtils.damp(head.current.rotation.z, rig.headRoll, 7, Math.min(delta, .05))
    }
    rig.arms.forEach((arm, index) => {
      fitBone(upperArms.current[index], arm.shoulder, arm.elbow)
      fitBone(lowerArms.current[index], arm.elbow, arm.wrist)
      if (elbows.current[index]) elbows.current[index].position.set(...arm.elbow)
      if (hands.current[index]) hands.current[index].position.set(...arm.wrist)
    })
    rig.legs.forEach((leg, index) => {
      fitBone(thighs.current[index], leg.hip, leg.knee)
      fitBone(shins.current[index], leg.knee, leg.ankle)
      if (knees.current[index]) knees.current[index].position.set(...leg.knee)
      if (shoes.current[index]) {
        shoes.current[index].position.set(...leg.foot)
        shoes.current[index].rotation.x = rig.shoePitch[index]
      }
    })
    if (halo.current) halo.current.rotation.z = t * .3
  })

  return <group onClick={event => { event.stopPropagation(); onSelect() }}
    onPointerOver={event => { event.stopPropagation(); document.body.style.cursor = 'pointer' }}
    onPointerOut={() => { document.body.style.cursor = 'auto' }}>
    {selected && <mesh ref={halo} position={[0, .035, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <torusGeometry args={[.57, .028, 8, 48]}/><meshBasicMaterial color={displayColor} toneMapped={false}/>
    </mesh>}
    <group ref={model}>
      <group ref={torso}>
        <RoundedBox position={[0, 1.40, -.045]} args={[.7, .70, .48]} radius={.21} castShadow>
          <meshStandardMaterial color={displayColor} roughness={.88}/>
        </RoundedBox>
        <RoundedBox position={[0, 1.13, -.055]} args={[.54, .23, .42]} radius={.09} castShadow>
          <meshStandardMaterial color="#344b66" roughness={.9}/>
        </RoundedBox>
        <mesh position={[0, 1.635, .214]}><boxGeometry args={[.13, .075, .014]}/><meshStandardMaterial color="#e9eef4"/></mesh>
        {[-1, 1].map(side => <RoundedBox key={side} position={[side * .365, 1.61, -.02]} args={[.245, .255, .32]} radius={.105} castShadow>
          <meshStandardMaterial color={displayColor} roughness={.9}/>
        </RoundedBox>)}
        <mesh position={[0, 1.775, -.015]}><cylinderGeometry args={[.105, .105, .19, 10]}/><meshStandardMaterial color={skin}/></mesh>
        <group ref={head} position={[0, 1.98, 0]}>
          <mesh castShadow><sphereGeometry args={[.275, 20, 16]}/><meshStandardMaterial color={skin} roughness={.83}/></mesh>
          <mesh position={[0, .105, -.018]} castShadow><sphereGeometry args={[.287, 20, 14, 0, Math.PI * 2, 0, Math.PI * .55]}/><meshStandardMaterial color={hair} roughness={.91}/></mesh>
          {[-1, 1].map(side => <group key={side}>
            <mesh position={[side * .117, .013, .247]} scale={[.8, 1.2, .65]}><sphereGeometry args={[.023, 9, 7]}/><meshStandardMaterial color="#172638"/></mesh>
            <mesh position={[side * .117, .09, .235]} rotation={[0, 0, side * -.14]}><boxGeometry args={[.085, .018, .017]}/><meshStandardMaterial color={hair}/></mesh>
            <mesh position={[side * .271, -.04, 0]}><sphereGeometry args={[.062, 8, 8]}/><meshStandardMaterial color={skin}/></mesh>
          </group>)}
          <mesh position={[0, -.048, .269]}><sphereGeometry args={[.036, 9, 7]}/><meshStandardMaterial color={skin}/></mesh>
          <mesh position={[0, -.132, .242]} rotation={[0, 0, Math.PI]}><torusGeometry args={[.06, .008, 5, 16, Math.PI]}/><meshStandardMaterial color="#814d4a"/></mesh>
        </group>
      </group>
      {[-1, 1].map((side, index) => <group key={`arm-${side}`}>
        <mesh ref={node => { if (node) upperArms.current[index] = node }} castShadow>
          <cylinderGeometry args={[.108, .112, 1, 10]}/><meshStandardMaterial color={displayColor} roughness={.88}/>
        </mesh>
        <mesh ref={node => { if (node) elbows.current[index] = node }} castShadow>
          <sphereGeometry args={[.084, 10, 8]}/><meshStandardMaterial color={skin} roughness={.87}/>
        </mesh>
        <mesh ref={node => { if (node) lowerArms.current[index] = node }} castShadow>
          <cylinderGeometry args={[.079, .086, 1, 10]}/><meshStandardMaterial color={skin} roughness={.86}/>
        </mesh>
        <group ref={node => { if (node) hands.current[index] = node }}>
          <RoundedBox args={[.16, .085, .145]} radius={.034} castShadow>
            <meshStandardMaterial color={skin} roughness={.86}/>
          </RoundedBox>
          {[-.056, -.019, .019, .056].map((x, finger) => <RoundedBox key={finger}
            position={[x, -.012, .103 + (finger === 1 || finger === 2 ? .012 : 0)]}
            args={[.031, .047, finger === 1 || finger === 2 ? .112 : .09]} radius={.015} castShadow>
            <meshStandardMaterial color={skin} roughness={.86}/>
          </RoundedBox>)}
          <RoundedBox position={[side * .102, -.026, .012]} rotation={[0, side * .3, 0]}
            args={[.058, .061, .085]} radius={.025} castShadow>
            <meshStandardMaterial color={skin} roughness={.86}/>
          </RoundedBox>
          {side === 1 && <group ref={coffeeCup} visible={false} position={[0, .065, .16]}>
            <mesh castShadow>
              <cylinderGeometry args={[.056, .046, .14, 14]}/><meshStandardMaterial color="#f7f1e6" roughness={.46}/>
            </mesh>
            <mesh position={[0, .066, 0]}>
              <cylinderGeometry args={[.047, .047, .006, 14]}/><meshStandardMaterial color="#75503d" roughness={.42}/>
            </mesh>
            <mesh position={[.06, .006, 0]} rotation={[0, 0, Math.PI / 2]}>
              <torusGeometry args={[.037, .009, 7, 14]}/><meshStandardMaterial color="#eee7dc" roughness={.5}/>
            </mesh>
          </group>}
        </group>
      </group>)}
      {[-1, 1].map((side, index) => <group key={`leg-${side}`}>
        <mesh ref={node => { if (node) thighs.current[index] = node }} castShadow>
          <cylinderGeometry args={[.134, .145, 1, 10]}/><meshStandardMaterial color="#344961" roughness={.9}/>
        </mesh>
        <mesh ref={node => { if (node) knees.current[index] = node }} castShadow>
          <sphereGeometry args={[.122, 10, 8]}/><meshStandardMaterial color="#344961" roughness={.9}/>
        </mesh>
        <mesh ref={node => { if (node) shins.current[index] = node }} castShadow>
          <cylinderGeometry args={[.105, .125, 1, 10]}/><meshStandardMaterial color="#344961" roughness={.9}/>
        </mesh>
        <RoundedBox ref={node => { if (node) shoes.current[index] = node }} args={[.275, .12, .39]} radius={.045} castShadow>
          <meshStandardMaterial color="#233248" roughness={.86}/>
          {/* Raised shoe collar overlaps the ankle and shin on every frame. */}
          <RoundedBox position={[0, .105, -.075]} args={[.205, .205, .22]} radius={.054} castShadow>
            <meshStandardMaterial color="#233248" roughness={.86}/>
          </RoundedBox>
          <mesh position={[0, -.055, .022]}><boxGeometry args={[.29, .035, .405]}/><meshStandardMaterial color="#c1cbd6" roughness={.84}/></mesh>
          <mesh position={[0, .062, .07]}><boxGeometry args={[.16, .011, .12]}/><meshStandardMaterial color="#dce4ed" roughness={.87}/></mesh>
        </RoundedBox>
      </group>)}
    </group>
  </group>
}
