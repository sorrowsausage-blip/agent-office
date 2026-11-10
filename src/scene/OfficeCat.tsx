import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import { MathUtils, type Group, type Mesh } from 'three'
import type { OfficeLayout } from './officeLayout'
import { catStateAt } from './officeCat'

// The office cat: light geometry only (body, head, ears, tail) — it never
// reuses the human avatar rig. Pure decoration on a fixed clock cycle (see
// officeCat.ts): it sleeps or strolls in the idle north band, never takes a
// resource, never blocks a desk or the main passage, and ambient off hides
// it entirely.
const FUR = '#c97b3d'
const CREAM = '#f2e3c8'

export function OfficeCat({ layout, ambientEnabled }: { layout: OfficeLayout; ambientEnabled: boolean }) {
  const group = useRef<Group>(null)
  const body = useRef<Mesh>(null)
  const head = useRef<Group>(null)
  const tail = useRef<Mesh>(null)
  useFrame(({ clock }, delta) => {
    if (!group.current) return
    const t = clock.elapsedTime
    const state = catStateAt(t, layout, ambientEnabled)
    group.current.visible = state.pose !== 'hidden'
    if (state.pose === 'hidden') return
    group.current.position.x = state.position[0]
    group.current.position.z = state.position[1]
    const turn = MathUtils.euclideanModulo(state.facing - group.current.rotation.y + Math.PI, Math.PI * 2) - Math.PI
    group.current.rotation.y += MathUtils.clamp(turn, -Math.min(delta, .05) * 5, Math.min(delta, .05) * 5)
    const walking = state.pose === 'walk'
    const bob = walking ? Math.abs(Math.sin(t * 6)) * .025 : 0
    if (body.current) {
      body.current.position.y = .2 + bob
      // Lying flattens the body, sitting stretches it upright; the scale
      // switches with the pose, the position never jumps.
      const squash = state.pose === 'lie' ? .62 : state.pose === 'sit' ? 1.18 : 1
      body.current.scale.set(1, squash, state.pose === 'sit' ? .82 : 1)
    }
    if (head.current) {
      head.current.position.y = state.pose === 'lie' ? .24 : state.pose === 'sit' ? .52 : .34 + bob
      head.current.position.z = state.pose === 'lie' ? .3 : state.pose === 'sit' ? .16 : .26
      head.current.rotation.x = state.pose === 'lie' ? .3 : 0
    }
    if (tail.current) {
      tail.current.rotation.y = Math.sin(t * (walking ? 3 : 1.2)) * (walking ? .35 : .12)
      tail.current.rotation.x = state.pose === 'lie' ? 1.2 : -.5
    }
  })
  return <group ref={group} visible={false}>
    {/* Body faces +Z, like the avatars: head forward, tail back. */}
    <mesh ref={body} position={[0, .2, 0]} castShadow>
      <sphereGeometry args={[.22, 12, 10]}/>
      <meshStandardMaterial color={FUR} roughness={.9}/>
    </mesh>
    <mesh position={[0, .2, -.05]}><sphereGeometry args={[.19, 12, 10]}/><meshStandardMaterial color={CREAM} roughness={.9}/></mesh>
    <group ref={head} position={[0, .34, .26]}>
      <mesh castShadow><sphereGeometry args={[.16, 14, 12]}/><meshStandardMaterial color={FUR} roughness={.9}/></mesh>
      <mesh position={[0, -.05, .13]}><sphereGeometry args={[.07, 10, 8]}/><meshStandardMaterial color={CREAM} roughness={.9}/></mesh>
      {[-1, 1].map(side => <group key={side}>
        <mesh position={[side * .09, .13, 0]} rotation={[0, 0, side * -.25]}>
          <coneGeometry args={[.055, .11, 6]}/><meshStandardMaterial color={FUR} roughness={.9}/>
        </mesh>
        <mesh position={[side * .062, .015, .145]} scale={[.8, 1.2, .6]}>
          <sphereGeometry args={[.018, 8, 6]}/><meshStandardMaterial color="#172638"/>
        </mesh>
      </group>)}
      <mesh position={[0, -.015, .16]}><sphereGeometry args={[.022, 8, 6]}/><meshStandardMaterial color="#b06a5a"/></mesh>
    </group>
    <mesh ref={tail} position={[0, .26, -.3]} rotation={[-.5, 0, 0]}>
      <cylinderGeometry args={[.035, .05, .42, 8]}/><meshStandardMaterial color={FUR} roughness={.9}/>
    </mesh>
  </group>
}
