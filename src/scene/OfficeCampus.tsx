import { RoundedBox } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import { Vector3, type Group } from 'three'
import { DEPARTMENTS } from '../agents'
import { departmentDecor, livingZoneDecor } from './officeDecor'
import type { Department } from '../types'
import type { OfficeLayout, Sector } from './officeLayout'
import type { OfficePreferences } from './officePreferences'

const THEMES = {
  daylight: { floor: '#e7edf3', tile: '#f7f9fc', wall: '#e9f0f7', outline: '#b7c9d8', frame: '#e5edf4', window: '#9dcae7', outer: '#dbe5ef', furniture: '#b9a493' },
  midnight: { floor: '#26364a', tile: '#304156', wall: '#182941', outline: '#6a8ca8', frame: '#16273d', window: '#6a98bd', outer: '#172538', furniture: '#a48b78' },
  warm: { floor: '#ecdfd2', tile: '#f8efe4', wall: '#f0e4d9', outline: '#d3b6a0', frame: '#e5d5c5', window: '#add5e5', outer: '#e8d8c8', furniture: '#b89980' },
} as const

function Planter({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <mesh position={[0, .25, 0]}><cylinderGeometry args={[.27, .18, .5, 8]}/><meshStandardMaterial color="#6d7888" roughness={.75}/></mesh>
    {[0, 1, 2, 3, 4, 5].map(i => <mesh key={i} position={[Math.sin(i * 2.4) * .23, .69 + i % 3 * .1, Math.cos(i * 2.4) * .2]} rotation={[.2 * i, 0, .15 * i]}>
      <sphereGeometry args={[.2, 7, 6]}/><meshStandardMaterial color={i % 2 ? '#51a98b' : '#4c826f'}/>
    </mesh>)}
  </group>
}

function Panel({ x, y, z, w, h, color = '#5e87ab' }: { x: number; y: number; z: number; w: number; h: number; color?: string }) {
  // Mount project boards on the back wall, clear of desks and walking routes.
  // Cut them away with the wall when viewed from behind the room.
  const panel = useRef<Group>(null)
  const world = useRef(new Vector3())
  const boardW = Math.min(w, 2.7), boardH = Math.min(h, 1.3)
  useFrame(({ camera }) => {
    if (!panel.current) return
    panel.current.getWorldPosition(world.current)
    panel.current.visible = camera.position.z > world.current.z - .07
  })
  return <group ref={panel} position={[x, y, z]}>
    <RoundedBox args={[boardW + .12, boardH + .12, .082]} radius={.035} castShadow>
      <meshStandardMaterial color="#71869b" roughness={.72}/>
    </RoundedBox>
    <RoundedBox position={[0, 0, .048]} args={[boardW, boardH, .027]} radius={.016}>
      <meshStandardMaterial color="#f5f8f8" roughness={.88}/>
    </RoundedBox>
    <mesh position={[0, boardH * .33, .065]}><planeGeometry args={[boardW * .88, .11]}/>
      <meshStandardMaterial color={color} roughness={.9}/>
    </mesh>
    {Array.from({ length: 4 }, (_, i) => <group key={i} position={[-boardW * .37, boardH * .12 - i * boardH * .18, .068]}>
      <mesh position={[.045, 0, 0]}><circleGeometry args={[.034, 10]}/><meshBasicMaterial color={i % 2 ? '#84b4b4' : color}/></mesh>
      <mesh position={[boardW * .25, 0, 0]}><planeGeometry args={[boardW * (.37 + i % 2 * .12), .025]}/>
        <meshBasicMaterial color="#90a7b8"/></mesh>
    </group>)}
  </group>
}

function Bookshelf({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <mesh position={[0, 1.05, 0]}><boxGeometry args={[1.5, 2.1, .48]}/><meshStandardMaterial color="#515369"/></mesh>
    {[0, 1, 2, 3].map(row => <group key={row} position={[0, .34 + row * .46, .27]}>
      <mesh><boxGeometry args={[1.41, .055, .1]}/><meshStandardMaterial color="#c1a484"/></mesh>
      {Array.from({ length: 7 }, (_, i) => <mesh key={i} position={[-.58 + i * .19, .0275 + (.32 + (i % 3) * .038) / 2, 0]}><boxGeometry args={[.13, .32 + (i % 3) * .038, .18]}/><meshStandardMaterial color={['#d2b18a', '#7aabaf', '#a6a1cc', '#6c829c'][i % 4]}/></mesh>)}
    </group>)}
  </group>
}

// Shallow storage is attached to the far-right architectural edge. Full-size
// bookcases placed between workstations previously invaded chair approaches.
function SupplyWall({ x, z, dark, accent }: { x: number; z: number; dark: boolean; accent: string }) {
  return <group position={[x, 0, z]}>
    <RoundedBox position={[0, 1.03, 0]} args={[.46, 2.06, 1.46]} radius={.045} castShadow>
      <meshStandardMaterial color={dark ? '#3d5367' : '#e4ebed'} roughness={.83}/>
    </RoundedBox>
    {[.47, 1.05, 1.65].map((y, i) => <group key={y} position={[-.242, y, 0]}>
      <mesh><boxGeometry args={[.018, .025, 1.31]}/><meshStandardMaterial color={accent} roughness={.78}/></mesh>
      {[-.41, -.1, .21, .47].map((offset, j) => <RoundedBox key={j} position={[-.018, .1 + (j % 2) * .018, offset]}
        args={[.035, .24 + (j % 2) * .035, .19]} radius={.008} castShadow>
        <meshStandardMaterial color={['#8baebe', '#d0aa7c', '#94bba3', '#aaa5cb'][(i + j) % 4]} roughness={.9}/>
      </RoundedBox>)}
    </group>)}
    <RoundedBox position={[-.26, 1.99, 0]} args={[.033, .1, 1.36]} radius={.016}>
      <meshStandardMaterial color={accent}/>
    </RoundedBox>
  </group>
}

function TeamNoticeWall({ width, depth, dark, accent }: { width: number; depth: number; dark: boolean; accent: string }) {
  const z = -depth / 2 + .41
  const length = Math.min(width - 2.1, 6.5)
  return <group position={[0, 1.98, z]}>
    <RoundedBox args={[length, 1.05, .085]} radius={.04} castShadow>
      <meshStandardMaterial color={dark ? '#364b61' : '#d8e4e8'} roughness={.8}/>
    </RoundedBox>
    <RoundedBox position={[0, 0, .054]} args={[length - .17, .89, .02]} radius={.021}>
      <meshStandardMaterial color={dark ? '#203348' : '#f9fbfa'} roughness={.92}/>
    </RoundedBox>
    {Array.from({ length: 3 }, (_, i) => {
      const colWidth = (length - .45) / 3
      const x = (i - 1) * colWidth
      return <group key={i} position={[x, 0, .077]}>
        <mesh position={[0, .29, 0]}><boxGeometry args={[colWidth - .25, .062, .009]}/>
          <meshStandardMaterial color={i === 0 ? accent : i === 1 ? '#77a9ba' : '#a99bc3'}/>
        </mesh>
        {Array.from({ length: 3 }, (_, n) => <group key={n} position={[-(colWidth - .55) / 2, .08 - n * .19, .006]}>
          <mesh position={[.03, 0, 0]}><circleGeometry args={[.034, 12]}/><meshBasicMaterial color={n === 2 ? '#9bc7af' : accent}/></mesh>
          <mesh position={[.15 + (colWidth - .8) * .3, 0, 0]}><planeGeometry args={[Math.max(.15, colWidth - .85 - n * .13), .025]}/>
            <meshBasicMaterial color={dark ? '#7798ae' : '#93aab5'}/>
          </mesh>
        </group>)}
      </group>
    })}
  </group>
}

// Wall-mounted fixtures bring visual depth to the shared studio without
// consuming precious aisle space or adding furniture that agents could clip.
function StudioIdentity({ width, depth, dark, accent }: { width: number; depth: number; dark: boolean; accent: string }) {
  const wallZ = -depth / 2 + .41
  return <group>
    <TeamNoticeWall width={width} depth={depth} dark={dark} accent={accent}/>
    <SupplyWall x={width / 2 - .39} z={-depth / 2 + 1.42} dark={dark} accent={accent}/>
    {/* One shallow identity bar above the team noticeboard. Both are fixed to
        the wall with a visible gap; avoid duplicate floating boards or clocks. */}
    <RoundedBox position={[0, 2.71, wallZ]} args={[Math.min(6.6, width - 1.2), .14, .075]} radius={.025}>
      <meshStandardMaterial color={dark ? '#415f71' : '#b9cbd1'} roughness={.85}/>
    </RoundedBox>
    <mesh position={[0, 2.71, wallZ + .045]}>
      <boxGeometry args={[Math.min(1.4, width * .27), .044, .008]}/>
      <meshBasicMaterial color={accent}/>
    </mesh>
  </group>
}

function DepartmentProps({ id, width, depth }: { id: Department; width: number; depth: number }) {
  const decor = departmentDecor(id, width, depth)
  return <>
    {decor.boards.map((board, i) => <Panel key={`board-${i}`} {...board}/>)}
    {decor.furniture.map((item, i) => {
      const key = `fixture-${i}`
      if (item.kind === 'books') return <Bookshelf key={key} x={item.x} z={item.z}/>
      if (item.kind === 'board' || item.kind === 'cabinet') return <mesh key={key} position={[item.x, item.y, item.z]}>
        <boxGeometry args={[item.width, item.height, item.depth]}/><meshStandardMaterial color={item.kind === 'board' ? '#cfd7d8' : '#1c2a3e'}/>
      </mesh>
      if (item.kind === 'server') return <group key={key} position={[item.x, 0, item.z]}>
        <mesh position={[0, 1.01, -.1]}><boxGeometry args={[1.04, 2.02, .64]}/><meshStandardMaterial color="#526577"/></mesh>
        {[0, 1, 2].map(n => <mesh key={n} position={[0, .47 + n * .65, .28]}><boxGeometry args={[.92, .58, .12]}/><meshStandardMaterial color="#1a304c" emissive="#215374" emissiveIntensity={.22}/></mesh>)}
        {[0, 1, 2].map(n => <mesh key={`led-${n}`} position={[.3, .44 + n * .65, .355]}><sphereGeometry args={[.036, 8, 8]}/><meshBasicMaterial color="#5de0c8"/></mesh>)}
      </group>
      if (item.kind === 'rack') return <group key={key} position={[item.x, 0, item.z]}>
        {[-.7, .7].map(x => <mesh key={x} position={[x, .85, 0]}><boxGeometry args={[.07, 1.7, .56]}/><meshStandardMaterial color="#657584"/></mesh>)}
        {[0, 1, 2].map(n => <mesh key={n} position={[0, .5 + n * .44, 0]}><boxGeometry args={[1.6, .25, .55]}/><meshStandardMaterial color={n === 2 ? '#779a89' : '#535e71'}/></mesh>)}
      </group>
      return <group key={key} position={[item.x, 0, item.z]}>
        <mesh position={[0, 1, 0]} rotation={[-.1, 0, 0]}><boxGeometry args={[1.13, 1.6, .08]}/><meshStandardMaterial color="#c7a594"/></mesh>
        {[-.4, .4].map(x => <mesh key={x} position={[x, .51, -.08]}><boxGeometry args={[.07, 1.02, .11]}/><meshStandardMaterial color="#8a766f"/></mesh>)}
        {['#eea3a2', '#dbd18d', '#82bec5'].map((color, n) => <mesh key={color} position={[0, 1.5 - n * .45, .08]}><boxGeometry args={[.8, .32, .022]}/><meshStandardMaterial color={color}/></mesh>)}
      </group>
    })}
    {decor.planter && <Planter x={decor.planter.x} z={decor.planter.z}/>}
  </>
}

function SectorRoom({ sector, preferences, detailed = true }: { sector: Sector; preferences: OfficePreferences; detailed?: boolean }) {
  const { center: [cx, , cz], width, depth, id } = sector
  const backArchitecture = useRef<Group>(null)
  // Cutting the nearest wall is essential for an orbitable isometric scene:
  // an opaque parapet in front of the camera obscures avatars and desks.
  useFrame(({ camera }) => {
    if (backArchitecture.current) {
      backArchitecture.current.visible = camera.position.z > cz - depth / 2 + .35
    }
  })
  const accent = preferences.sectorColors[id] || DEPARTMENTS.find(dep => dep.id === id)?.color || '#9aacc0'
  const palette = THEMES[preferences.theme]
  const dark = preferences.theme === 'midnight'
  const back = -depth / 2
  const fixtureCount = Math.max(1, Math.min(3, Math.round(width / 4.6)))
  if (!detailed) return <group position={[cx, 0, cz]}>
    <mesh position={[0, .001, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[width - .28, depth - .28]}/><meshStandardMaterial color={accent} transparent opacity={.12} depthWrite={false}/></mesh>
    <mesh position={[0, .55, back + .12]}><boxGeometry args={[width - .3, 1.1, .16]}/><meshStandardMaterial color={palette.wall} roughness={.9}/></mesh>
  </group>
  return <group position={[cx, 0, cz]}>
    {/* One continuous office floor, with subtle team-colored zoning only. */}
    <mesh position={[0, .001, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[width - .28, depth - .28]}/>
      <meshStandardMaterial color={palette.floor} transparent opacity={.18} roughness={.92} depthWrite={false}/>
    </mesh>
    <mesh position={[0, .005, -depth / 2 + .27]}><boxGeometry args={[width - .55, .006, .13]}/><meshStandardMaterial color={accent} transparent opacity={.65}/></mesh>
    {/* Floor-level circulation markers make the route legible without
        placing a single obstacle in an agent's walking path. */}
    {Array.from({ length: Math.max(0, Math.floor((depth - 2.3) / 1.18)) }, (_, i) =>
      <mesh key={`aisle-mark-${i}`} position={[-width / 2 + .58, .006, -depth / 2 + 2.05 + i * 1.18]}>
        <boxGeometry args={[.40, .006, .095]}/>
        <meshStandardMaterial color={accent} transparent opacity={.35} roughness={.98}/>
      </mesh>)}
    {/* A shared studio gets real architectural edges without interior walls
        isolating the team. Low wall cladding leaves the window bays visible. */}
    <group ref={backArchitecture}>
    <RoundedBox position={[0, .59, back + .13]} args={[width - .35, 1.13, .17]} radius={.035} receiveShadow>
      <meshStandardMaterial color={dark ? '#33465c' : '#f6f8f8'} roughness={.91}/>
    </RoundedBox>
    <mesh position={[0, 1.16, back + .25]}><boxGeometry args={[width - .44, .055, .09]}/><meshStandardMaterial color={accent} roughness={.87}/></mesh>
    {/* Frosted upper glass and mullions give depth to the office without
        adding partitions between teammates. */}
    <mesh position={[0, 1.98, back + .12]}>
      <boxGeometry args={[width - .42, 1.57, .055]}/>
      <meshStandardMaterial color={palette.window} transparent opacity={dark ? .22 : .13} depthWrite={false} roughness={.28} metalness={.09}/>
    </mesh>
    {Array.from({length: Math.max(2, Math.ceil(width / 3))}, (_, i) =>
      <mesh key={`glazing-frame-${i}`} position={[-width / 2 + .22 + i * ((width - .44) / Math.max(1, Math.ceil(width / 3) - 1)), 1.97, back + .19]}>
        <boxGeometry args={[.046, 1.65, .071]}/>
        <meshStandardMaterial color={dark ? '#526b80' : '#b5c9d6'} roughness={.76}/>
      </mesh>)}
    {Array.from({length: Math.max(2, Math.floor(width / .9))}, (_, i) => {
      const x = -width / 2 + .47 + i * ((width - .94) / Math.max(1, Math.floor(width / .9) - 1))
      return <mesh key={`wall-slat-${i}`} position={[x, .58, back + .23]}>
        <boxGeometry args={[.025, .94, .02]}/><meshStandardMaterial color={dark ? '#5a7085' : '#d5e2e8'} roughness={.93}/>
      </mesh>
    })}
    {/* Suspended LED fixtures with physical mounts: visible from the camera,
        and located above the furniture, never floating in the work area. */}
    {Array.from({length: fixtureCount}, (_, i) => {
      const x = (i - (fixtureCount - 1) / 2) * Math.min(4.2, width / (fixtureCount + .35))
      return <group key={`light-${i}`} position={[x, 0, back + 2.15]}>
        {[-.62, .62].map(offset => <mesh key={`mount-${offset}`} position={[offset, 3.34, -.9]}><boxGeometry args={[.045, .07, 1.9]}/><meshStandardMaterial color={dark ? '#536d81' : '#b4c4cf'} metalness={.3}/></mesh>)}
        {[-.62, .62].map(offset => <mesh key={offset} position={[offset, 3.18, 0]}>
          <cylinderGeometry args={[.012, .012, .30, 6]}/><meshStandardMaterial color="#96a8b5" metalness={.5}/>
        </mesh>)}
        <RoundedBox position={[0, 3.01, 0]} args={[1.65, .075, .29]} radius={.025}>
          <meshStandardMaterial color={dark ? '#6c8798' : '#f8faf9'} emissive="#b7e4ee" emissiveIntensity={.22}/>
        </RoundedBox>
        <mesh position={[0, 2.964, 0]}><boxGeometry args={[1.47, .009, .19]}/><meshBasicMaterial color="#d8f4f2"/></mesh>
      </group>
    })}
    {/* Vertical structure, baseboards and a small plant grouping frame the
        space while keeping chair approaches and crossing aisles unobstructed. */}
    {[-1, 1].map(side => <group key={`pillar-${side}`} position={[side * (width / 2 - .12), 0, back + .28]}>
      <RoundedBox position={[0, 1.58, 0]} args={[.2, 3.16, .29]} radius={.035}>
        <meshStandardMaterial color={dark ? '#52667b' : '#bfcdd8'} roughness={.83}/>
      </RoundedBox>
      <mesh position={[0, 2.60, .16]}><boxGeometry args={[.08, .76, .027]}/><meshStandardMaterial color={accent}/></mesh>
    </group>)}
    <mesh position={[0, 3.23, back + .29]}><boxGeometry args={[width - .2, .13, .25]}/><meshStandardMaterial color={dark ? '#657d93' : '#d0dae3'} roughness={.68}/></mesh>
    {id === 'general' && <StudioIdentity width={width} depth={depth} dark={dark} accent={accent}/>}
    </group>
    <pointLight position={[0, 3.7, 0]} intensity={depth > 13 ? 2.4 : 1.6} distance={Math.max(9, depth * .9)} color="#e8f4ff"/>
    <DepartmentProps id={id} width={width} depth={depth}/>
  </group>
}

function SharedLounge({ x, z, theme }: { x: number; z: number; theme: OfficePreferences['theme'] }) {
  const tabletop = theme === 'midnight' ? '#9e8a7d' : theme === 'warm' ? '#d3ab86' : '#d6c4ac'
  return <group position={[x, 0, z]}>
    {/* The meeting spot is outside all workstation routes and chair footprints. */}
    <mesh position={[0, .003, 0]} receiveShadow>
      <cylinderGeometry args={[2.15, 2.15, .006, 40]}/><meshStandardMaterial color={theme === 'midnight' ? '#3d5965' : '#c8d7cf'} roughness={1}/>
    </mesh>
    <RoundedBox position={[0, .72, 0]} args={[2.25, .13, .98]} radius={.11} castShadow>
      <meshStandardMaterial color={tabletop} roughness={.76}/>
    </RoundedBox>
    {[-.73, .73].map(x => <mesh key={x} position={[x, .36, 0]}>
      <cylinderGeometry args={[.055, .07, .68, 10]}/><meshStandardMaterial color="#748395" metalness={.5}/>
    </mesh>)}
    {[-1, 1].map(side => <group key={side} position={[side * 1.62, 0, 0]} rotation={[0, side * Math.PI / 2, 0]}>
      <RoundedBox position={[0, .47, 0]} args={[.7, .12, .72]} radius={.1} castShadow><meshStandardMaterial color="#758da3"/></RoundedBox>
      <RoundedBox position={[0, .78, .31]} args={[.75, .63, .11]} radius={.075} castShadow><meshStandardMaterial color="#7897ac"/></RoundedBox>
      <mesh position={[0, .23, 0]}><cylinderGeometry args={[.055, .08, .45, 8]}/><meshStandardMaterial color="#677a8b"/></mesh>
    </group>)}
    <mesh position={[0, .82, 0]}><cylinderGeometry args={[.16, .16, .055, 12]}/><meshStandardMaterial color="#f6f8f8"/></mesh>
    <mesh position={[.45, .795, -.22]}><boxGeometry args={[.36, .018, .27]}/><meshStandardMaterial color="#a9c4d5"/></mesh>
    <mesh position={[-.43, .79, .16]}><boxGeometry args={[.44, .022, .3]}/><meshStandardMaterial color="#ece5db"/></mesh>
    <mesh position={[-.43, .806, .16]}><boxGeometry args={[.33, .002, .20]}/><meshStandardMaterial color="#89a5b5"/></mesh>
    <mesh position={[0, .915, 0]}><sphereGeometry args={[.105, 12, 10]}/><meshStandardMaterial color="#6caa91" roughness={.8}/></mesh>
  </group>
}

// Rest area (phase 2): three-seat sofa, rug, coffee table, bookshelf, plant
// and a warm floor lamp, in the south-west corner below the last coffee
// point. Sofa seats are at local x -1.15 / 0 / +1.15, matching restSeats.
function RestArea({ x, z, theme }: { x: number; z: number; theme: OfficePreferences['theme'] }) {
  const decor = livingZoneDecor('rest')
  const rug = theme === 'midnight' ? '#3d5965' : theme === 'warm' ? '#dcc3a8' : '#d8c9b4'
  return <group position={[x, 0, z]}>
    <mesh position={[0, .003, -.5]} receiveShadow>
      <boxGeometry args={[3.2, .006, 2.0]}/><meshStandardMaterial color={rug} roughness={1}/>
    </mesh>
    <RoundedBox position={[0, .21, 0]} args={[3.2, .42, .9]} radius={.09} castShadow>
      <meshStandardMaterial color="#a87f5f" roughness={.85}/>
    </RoundedBox>
    <RoundedBox position={[0, .6, .42]} args={[3.2, .78, .18]} radius={.08} castShadow>
      <meshStandardMaterial color="#a87f5f" roughness={.85}/>
    </RoundedBox>
    {[-1.52, 1.52].map(side => <RoundedBox key={side} position={[side, .55, 0]} args={[.16, .32, .9]} radius={.07} castShadow>
      <meshStandardMaterial color="#9a7355" roughness={.85}/>
    </RoundedBox>)}
    {[-1.05, 0, 1.05].map(cx => <group key={cx}>
      <RoundedBox position={[cx, .48, -.02]} args={[.95, .14, .78]} radius={.06}>
        <meshStandardMaterial color="#c49a72" roughness={.9}/>
      </RoundedBox>
      <RoundedBox position={[cx, .72, .32]} args={[.95, .5, .12]} radius={.05}>
        <meshStandardMaterial color="#c49a72" roughness={.9}/>
      </RoundedBox>
    </group>)}
    <RoundedBox position={[-1.15, .66, .3]} args={[.34, .34, .12]} radius={.05} rotation={[0, 0, .18]}>
      <meshStandardMaterial color="#7aabaf" roughness={.9}/>
    </RoundedBox>
    <RoundedBox position={[1.2, .66, .3]} args={[.34, .34, .12]} radius={.05} rotation={[0, 0, -.15]}>
      <meshStandardMaterial color="#d2b18a" roughness={.9}/>
    </RoundedBox>
    <RoundedBox position={[0, .42, -1.05]} args={[1.5, .07, .6]} radius={.03} castShadow>
      <meshStandardMaterial color="#d6c2a8" roughness={.75}/>
    </RoundedBox>
    <mesh position={[0, .2, -1.05]}><cylinderGeometry args={[.05, .07, .4, 10]}/><meshStandardMaterial color="#748395" metalness={.5}/></mesh>
    <mesh position={[.45, .5, -1.05]}><cylinderGeometry args={[.07, .09, .1, 10]}/><meshStandardMaterial color="#8fa9bd"/></mesh>
    <mesh position={[.45, .58, -1.05]}><sphereGeometry args={[.07, 10, 8]}/><meshStandardMaterial color="#6caa91" roughness={.8}/></mesh>
    <mesh position={[-.4, .475, -1.05]}><boxGeometry args={[.34, .03, .26]}/><meshStandardMaterial color="#a6a1cc"/></mesh>
    <mesh position={[-.4, .5, -1.05]}><boxGeometry args={[.3, .025, .22]}/><meshStandardMaterial color="#d2b18a"/></mesh>
    {decor.furniture.map((item, i) => item.kind === 'books' && <Bookshelf key={`rest-books-${i}`} x={item.x} z={item.z}/>)}
    {decor.planters.map((planter, i) => <Planter key={`rest-plant-${i}`} x={planter.x} z={planter.z}/>)}
    <mesh position={[-1.65, .02, -1.15]}><cylinderGeometry args={[.12, .14, .04, 12]}/><meshStandardMaterial color="#58667b" metalness={.4}/></mesh>
    <mesh position={[-1.65, .78, -1.15]}><cylinderGeometry args={[.02, .02, 1.5, 8]}/><meshStandardMaterial color="#58667b" metalness={.4}/></mesh>
    <mesh position={[-1.65, 1.62, -1.15]}><cylinderGeometry args={[.16, .24, .32, 12]}/><meshStandardMaterial color="#f2ddba" emissive="#ffd9a0" emissiveIntensity={.55} roughness={.9}/></mesh>
    <pointLight position={[-1.65, 1.55, -1.15]} intensity={.7} distance={4.5} color="#ffd9a0"/>
  </group>
}

// Window inspiration area (phase 2): floor marker, sill bench and a plant
// against the north glass facade. Thinking effects arrive in phase 3/4;
// this zone is only the place.
function WindowZone({ x, z, accent }: { x: number; z: number; accent: string }) {
  const decor = livingZoneDecor('window')
  return <group position={[x, 0, z]}>
    <RoundedBox position={[0, .004, 0]} args={[1.2, .006, 1.0]} radius={.05}>
      <meshStandardMaterial color={accent} transparent opacity={.16} depthWrite={false}/>
    </RoundedBox>
    <RoundedBox position={[0, .21, -.4]} args={[1.5, .42, .5]} radius={.06} castShadow>
      <meshStandardMaterial color="#8fa9bd" roughness={.85}/>
    </RoundedBox>
    <RoundedBox position={[0, .47, -.4]} args={[1.4, .1, .44]} radius={.04}>
      <meshStandardMaterial color="#dfe9ee" roughness={.9}/>
    </RoundedBox>
    <mesh position={[-.45, .535, -.4]}><boxGeometry args={[.3, .03, .22]}/><meshStandardMaterial color="#a6a1cc"/></mesh>
    <mesh position={[-.45, .565, -.4]}><boxGeometry args={[.26, .03, .2]}/><meshStandardMaterial color="#d2b18a"/></mesh>
    {decor.planters.map((planter, i) => <Planter key={`window-plant-${i}`} x={planter.x} z={planter.z}/>)}
  </group>
}

// Whiteboard collaboration zone (phase 2): freestanding board on the west
// glass wall, sticky notes and a floor marker for the discussion spot. The
// board group is rotated like the meeting/focus wall panels; its absolute x
// is pinned to .42 so it stays clear of the coffee mats to its south.
function CollabZone({ x, z, accent, dark }: { x: number; z: number; accent: string; dark: boolean }) {
  const decor = livingZoneDecor('collab')
  const board = decor.boards[0]
  return <group position={[x, 0, z]}>
    <RoundedBox position={[0, .004, 0]} args={[1.2, .006, 1.0]} radius={.05}>
      <meshStandardMaterial color={accent} transparent opacity={.14} depthWrite={false}/>
    </RoundedBox>
    <group position={[.42 - x, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
      <RoundedBox position={[0, 1.1, 0]} args={[1.5, 2.2, .14]} radius={.035}>
        <meshStandardMaterial color={dark ? '#3a5164' : '#d9e3e8'} roughness={.85}/>
      </RoundedBox>
      {board && <Panel x={board.x} y={board.y} z={board.z} w={board.w} h={board.h} color={accent}/>}
      {[[-.5, 1.15, '#e8c85a'], [.08, 1.9, '#9bc7af'], [.52, 1.2, '#e8a0a0']].map(([nx, ny, color]) => <mesh key={`${nx}-${ny}`} position={[nx as number, ny as number, .18]}>
        <boxGeometry args={[.17, .17, .012]}/><meshStandardMaterial color={color as string} roughness={.9}/>
      </mesh>)}
    </group>
  </group>
}

function CoffeePoint({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <mesh position={[0, .003, 0]}><boxGeometry args={[4.9, .006, 2.25]}/><meshStandardMaterial color="#d6dfdb" roughness={1}/></mesh>
    <RoundedBox position={[0, .53, 0]} args={[3.4, 1.06, .7]} radius={.07} castShadow>
      <meshStandardMaterial color="#8298a8" roughness={.76}/>
    </RoundedBox>
    <RoundedBox position={[0, 1.09, 0]} args={[3.55, .12, .8]} radius={.04} castShadow>
      <meshStandardMaterial color="#d6c2a8" roughness={.73}/>
    </RoundedBox>
    <RoundedBox position={[-.35, 1.39, -.1]} args={[.6, .48, .4]} radius={.035}>
      <meshStandardMaterial color="#2e455b" metalness={.25}/>
    </RoundedBox>
    <mesh position={[-.35, 1.45, .16]}><boxGeometry args={[.2, .04, .16]}/><meshStandardMaterial color="#b9d6df"/></mesh>
    {[.4, .72].map(px => <mesh key={px} position={[px, 1.235, .04]}><cylinderGeometry args={[.1, .095, .16, 12]}/><meshStandardMaterial color="#f7f1e6"/></mesh>)}
    {[-1.15, 1.25].map(px => <group key={px} position={[px, .56, .359]}>
      <mesh><boxGeometry args={[.73, .82, .015]}/><meshStandardMaterial color="#dce4e5"/></mesh>
      <mesh position={[0, .29, .022]}><boxGeometry args={[.23, .025, .018]}/><meshStandardMaterial color="#6d8496"/></mesh>
    </group>)}
    <group position={[1.3, 1.16, -.03]}><mesh position={[0, .07, 0]}><cylinderGeometry args={[.14, .14, .14, 12]}/><meshStandardMaterial color="#ddb389"/></mesh>
      <mesh position={[0, .29, 0]}><sphereGeometry args={[.22, 10, 8]}/><meshStandardMaterial color="#78a897"/></mesh></group>
    <RoundedBox position={[0, 1.95, -.5]} args={[3.5, .65, .13]} radius={.035}><meshStandardMaterial color="#c2d3d3"/></RoundedBox>
    <mesh position={[0, 1.43, -.38]}><boxGeometry args={[3.45, .65, .12]}/><meshStandardMaterial color="#9db6b4" roughness={.83}/></mesh>
    <mesh position={[0, 1.97, -.423]}><boxGeometry args={[1.7, .05, .008]}/><meshStandardMaterial color="#689b8d"/></mesh>
    {/* Pantry dressing: the coffee corner is the pantry. Fridge and prep
        table stand on the front (south) side, dispenser and snack cabinet on
        the back side clear of the wall shelf; the mug tree on the prep table
        is the cup rack. Every piece stays inside the corner mat and clear of
        the walking stop at (0, +0.98). */}
    <group position={[-2.2, 0, .55]}>
      <RoundedBox position={[0, .95, 0]} args={[.7, 1.9, .65]} radius={.04} castShadow><meshStandardMaterial color="#dfe7ea" roughness={.7}/></RoundedBox>
      <mesh position={[0, 1.3, .33]}><boxGeometry args={[.62, .02, .012]}/><meshStandardMaterial color="#9fb2bd"/></mesh>
      <mesh position={[.22, 1.5, .34]}><boxGeometry args={[.045, .3, .03]}/><meshStandardMaterial color="#7a8b98"/></mesh>
    </group>
    <group position={[2.05, 0, -.55]}>
      <mesh position={[0, .625, 0]}><boxGeometry args={[.55, 1.25, .5]}/><meshStandardMaterial color="#e8eef0" roughness={.7}/></mesh>
      <mesh position={[0, 1.42, 0]}><cylinderGeometry args={[.17, .17, .34, 12]}/><meshStandardMaterial color="#9dc8dd" transparent opacity={.55} roughness={.3}/></mesh>
      <mesh position={[0, .85, .27]}><boxGeometry args={[.1, .12, .05]}/><meshStandardMaterial color="#5e7a8c"/></mesh>
      <mesh position={[0, .76, .28]}><boxGeometry args={[.2, .03, .12]}/><meshStandardMaterial color="#7a8b98"/></mesh>
    </group>
    <group position={[2.05, 0, .55]}>
      <RoundedBox position={[0, .425, 0]} args={[.7, .85, .5]} radius={.04} castShadow><meshStandardMaterial color="#b98d5f" roughness={.8}/></RoundedBox>
      <mesh position={[0, .45, .256]}><boxGeometry args={[.6, .02, .012]}/><meshStandardMaterial color="#8a6a45"/></mesh>
      {[[-.18, '#d2b18a'], [.05, '#7aabaf'], [.24, '#a6a1cc']].map(([px, color]) => <mesh key={px as number} position={[px as number, .91, 0]}>
        <boxGeometry args={[.16, .12, .18]}/><meshStandardMaterial color={color as string} roughness={.9}/>
      </mesh>)}
    </group>
    <group position={[-2.15, 0, -.55]}>
      <RoundedBox position={[0, .78, 0]} args={[.7, .06, .55]} radius={.02} castShadow><meshStandardMaterial color="#d6c2a8" roughness={.75}/></RoundedBox>
      {[[-.3, -.22], [.3, -.22], [-.3, .22], [.3, .22]].map(([lx, lz]) => <mesh key={`${lx}-${lz}`} position={[lx, .39, lz]}><boxGeometry args={[.05, .78, .05]}/><meshStandardMaterial color="#8a766f"/></mesh>)}
      <mesh position={[0, .98, 0]}><cylinderGeometry args={[.018, .018, .32, 8]}/><meshStandardMaterial color="#7a8b98" metalness={.4}/></mesh>
      {[0, 1, 2].map(i => <mesh key={i} position={[Math.cos(i * 2.1) * .08, .9 + i * .07, Math.sin(i * 2.1) * .08]}>
        <cylinderGeometry args={[.05, .045, .09, 10]}/><meshStandardMaterial color={['#7aabaf', '#d2b18a', '#a6a1cc'][i]}/>
      </mesh>)}
    </group>
  </group>
}

function Reception({ x, z, accent }: { x: number; z: number; accent: string }) {
  return <group position={[x, 0, z]}>
    <mesh position={[0, .003, .4]}><boxGeometry args={[5.5, .006, 3.4]}/><meshStandardMaterial color="#d5dde7" roughness={1}/></mesh>
    <RoundedBox position={[0, .58, 0]} args={[3.3, 1.16, .85]} radius={.09} castShadow><meshStandardMaterial color="#e5e9eb" roughness={.8}/></RoundedBox>
    <RoundedBox position={[0, 1.19, 0]} args={[3.5, .10, .95]} radius={.045}><meshStandardMaterial color="#c1a283" roughness={.72}/></RoundedBox>
    {Array.from({ length: 12 }, (_, i) => <mesh key={i} position={[-1.4 + i * .25, .6, .434]}><boxGeometry args={[.065, .95, .018]}/><meshStandardMaterial color="#b29c83"/></mesh>)}
    <mesh position={[.8, 1.46, -.1]}><boxGeometry args={[.67, .45, .055]}/><meshStandardMaterial color="#2f4c60"/></mesh>
    <mesh position={[.8, 1.27, -.1]}><boxGeometry args={[.07, .15, .08]}/><meshStandardMaterial color="#617888"/></mesh>
    <mesh position={[-.75, 1.252, .05]}><boxGeometry args={[.56, .02, .35]}/><meshStandardMaterial color={accent}/></mesh>
    <RoundedBox position={[0, 2.03, -1.13]} args={[4.7, 1.7, .14]} radius={.04}><meshStandardMaterial color="#c6d2dc"/></RoundedBox>
    {[-1, 1].map(side => <RoundedBox key={side} position={[side * 1.34, 1.08, -1.03]} args={[.83, 2.12, .06]} radius={.015}><meshStandardMaterial color="#8193a4" metalness={.5} roughness={.45}/></RoundedBox>)}
    <mesh position={[0, 2.12, -.99]}><boxGeometry args={[.75, .35, .018]}/><meshStandardMaterial color={accent}/></mesh>
  </group>
}

function SupportWing({ layout, accent, dark }: { layout: OfficeLayout; accent: string; dark: boolean }) {
  return <group>
    <mesh position={[layout.spineX - 1.7, .002, layout.depth / 2]}><boxGeometry args={[.065, .006, layout.depth - .8]}/><meshStandardMaterial color="#a6bbb8"/></mesh>
    {layout.amenities.filter(amenity => amenity.id === 'meeting' || amenity.id === 'focus').map(amenity => <group key={amenity.key} position={[.55, 0, amenity.z]} rotation={[0, Math.PI / 2, 0]}>
      <RoundedBox position={[0, 1.25, 0]} args={[3.1, 2.5, .14]} radius={.035}><meshStandardMaterial color={dark ? '#3a5164' : '#d9e3e8'} roughness={.85}/></RoundedBox>
      <Panel x={0} y={1.65} z={.1} w={2.1} h={1.05} color={accent}/>
    </group>)}
    <Planter x={layout.width - .65} z={layout.depth - .6}/>
    <Planter x={.65} z={layout.depth - .65}/>
    <mesh position={[layout.width / 2, .009, layout.depth - .35]}><boxGeometry args={[layout.width - 1.2, .006, .045]}/><meshStandardMaterial color={accent}/></mesh>
  </group>
}

function FocusNook({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <RoundedBox position={[0, .48, -.15]} args={[1.35, .14, .76]} radius={.1} castShadow>
      <meshStandardMaterial color="#7088a3"/>
    </RoundedBox>
    <RoundedBox position={[0, .91, -.49]} args={[1.35, .82, .12]} radius={.1} castShadow>
      <meshStandardMaterial color="#6b829b"/>
    </RoundedBox>
    {[-.56, .56].map(side => <RoundedBox key={side} position={[side, .65, -.1]} args={[.13, .35, .83]} radius={.06}>
      <meshStandardMaterial color="#7088a3"/>
    </RoundedBox>)}
    <mesh position={[0, .13, -.2]}><boxGeometry args={[1.12, .22, .54]}/><meshStandardMaterial color="#53687f"/></mesh>
    {[-.55, .55].map(side => <mesh key={side} position={[side, 1.35, -.55]}><boxGeometry args={[.055, .28, .09]}/><meshStandardMaterial color="#98afc0"/></mesh>)}
    <mesh position={[0, 1.46, -.55]}><boxGeometry args={[1.62, .075, .13]}/><meshStandardMaterial color="#b8d7e0" emissive="#6e99ad" emissiveIntensity={.14}/></mesh>
  </group>
}

// Cut away the wall facing the camera so its glass and mullions cannot
// occlude the workers when the visitor orbits the building.
function GlassFacade({ width, depth, theme }: { width: number; depth: number; theme: OfficePreferences['theme'] }) {
  const backWall = useRef<Group>(null)
  const leftWall = useRef<Group>(null)
  useFrame(({ camera }) => {
    if (backWall.current) backWall.current.visible = camera.position.z > -.1
    if (leftWall.current) leftWall.current.visible = camera.position.x > -.1
  })
  const dark = theme === 'midnight'
  const frame = dark ? '#6c849f' : '#a4b7ca'
  const glass = dark ? '#426d92' : '#a7d8ec'
  const backPanels = Math.max(1, Math.ceil(width / 3.6))
  const sidePanels = Math.max(1, Math.ceil(depth / 3.6))
  return <group>
    <group ref={backWall}>
    {Array.from({ length: backPanels }, (_, index) => {
      const widthPer = width / backPanels
      return <group key={`back-${index}`} position={[(index + .5) * widthPer, 0, -.38]}>
        <mesh position={[0, 1.62, 0]}><boxGeometry args={[widthPer - .1, 2.95, .07]}/><meshStandardMaterial color={glass} transparent opacity={.12} depthWrite={false} metalness={.13} roughness={.18}/></mesh>
        <mesh position={[-widthPer / 2, 1.65, .015]}><boxGeometry args={[.075, 3.25, .1]}/><meshStandardMaterial color={frame} metalness={.5}/></mesh>
        <mesh position={[0, 2.15, .02]}><boxGeometry args={[widthPer, .045, .09]}/><meshStandardMaterial color={frame} metalness={.45}/></mesh>
      </group>
    })}
    <mesh position={[width / 2, 3.3, -.38]}><boxGeometry args={[width + .07, .14, .16]}/><meshStandardMaterial color={frame} metalness={.4}/></mesh>
    </group>
    <group ref={leftWall}>
    {Array.from({ length: sidePanels }, (_, index) => {
      const length = depth / sidePanels
      return <group key={`side-${index}`} position={[-.38, 0, (index + .5) * length]}>
        <mesh position={[0, 1.62, 0]}><boxGeometry args={[.07, 2.95, length - .1]}/><meshStandardMaterial color={glass} transparent opacity={.12} depthWrite={false} roughness={.18}/></mesh>
        <mesh position={[.015, 1.65, -length / 2]}><boxGeometry args={[.1, 3.25, .075]}/><meshStandardMaterial color={frame} metalness={.5}/></mesh>
      </group>
    })}
    <mesh position={[-.38, 3.3, depth / 2]}><boxGeometry args={[.16, .14, depth + .07]}/><meshStandardMaterial color={frame} metalness={.4}/></mesh>
    </group>
  </group>
}

export function OfficeCampus({ layout, preferences, detailedSectorKeys }: { layout: OfficeLayout; preferences: OfficePreferences; detailedSectorKeys: ReadonlySet<string> }) {
  const palette = THEMES[preferences.theme]
  return <group>
    <mesh position={[layout.width / 2, -.46, layout.depth / 2]} receiveShadow><boxGeometry args={[layout.width + 2.2, .7, layout.depth + 1.8]}/><meshStandardMaterial color={palette.outer} roughness={.98}/></mesh>
    {/* One continuous ground plane connects every team bay into a shared studio. */}
    <mesh position={[layout.width / 2, -.075, layout.depth / 2]} receiveShadow><boxGeometry args={[layout.width + 1.8, .14, layout.depth + 1.5]}/><meshStandardMaterial color={palette.tile} roughness={.91}/></mesh>
    {layout.passages.map((passage, index) => <group key={index} position={[passage.x, .002, passage.z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[passage.width, passage.depth]}/><meshStandardMaterial color={preferences.accent} transparent opacity={.09} depthWrite={false}/></mesh>
    </group>)}
    {layout.sectors.map(sector => <SectorRoom key={sector.key} sector={sector} preferences={preferences} detailed={detailedSectorKeys.has(sector.key)}/>)}
    {layout.amenities.map(amenity => amenity.id === 'meeting'
      ? <SharedLounge key={amenity.key} x={amenity.x} z={amenity.z} theme={preferences.theme}/>
      : amenity.id === 'coffee'
        ? <CoffeePoint key={amenity.key} x={amenity.x} z={amenity.z}/>
        : amenity.id === 'reception' ? <Reception key={amenity.key} x={amenity.x} z={amenity.z} accent={preferences.accent}/>
        : amenity.id === 'rest' ? <RestArea key={amenity.key} x={amenity.x} z={amenity.z} theme={preferences.theme}/>
        : amenity.id === 'window' ? <WindowZone key={amenity.key} x={amenity.x} z={amenity.z} accent={preferences.accent}/>
        : <FocusNook key={amenity.key} x={amenity.x} z={amenity.z}/>)}
    {layout.collabZone && <CollabZone key={layout.collabZone.key} x={layout.collabZone.x} z={layout.collabZone.z} accent={preferences.accent} dark={preferences.theme === 'midnight'}/>}    <SupportWing layout={layout} accent={preferences.accent} dark={preferences.theme === 'midnight'}/>
    <GlassFacade width={layout.width} depth={layout.depth} theme={preferences.theme}/>
    <ambientLight intensity={.47} color="#e5efff"/>
  </group>
}
