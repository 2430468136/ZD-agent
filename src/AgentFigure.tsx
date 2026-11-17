type Prop = 'tablet' | 'laptop' | 'clipboard' | 'swatches' | 'headset' | 'book'
type Persona = {
  skin: string
  hair: string
  outfit: string
  trim: string
  hairStyle: 'bob' | 'short' | 'long' | 'bun' | 'wave'
  prop: Prop
  glasses?: boolean
}

const personas: Record<string, Persona> = {
  ceo: { skin: '#d99b78', hair: '#3b302c', outfit: '#315b4b', trim: '#d4e2cf', hairStyle: 'bob', prop: 'tablet' },
  frontend: { skin: '#e6b08b', hair: '#382d29', outfit: '#557c9d', trim: '#dbe9f2', hairStyle: 'short', prop: 'laptop' },
  backend: { skin: '#bd8064', hair: '#292d32', outfit: '#777095', trim: '#e3dff2', hairStyle: 'long', prop: 'laptop', glasses: true },
  qa: { skin: '#edbd96', hair: '#664538', outfit: '#c87964', trim: '#f5e4dc', hairStyle: 'bun', prop: 'clipboard' },
  research: { skin: '#d69b77', hair: '#382a29', outfit: '#4c8d85', trim: '#d9efeb', hairStyle: 'long', prop: 'book', glasses: true },
  design: { skin: '#efc3a1', hair: '#64433d', outfit: '#bf748f', trim: '#f7e2eb', hairStyle: 'wave', prop: 'swatches' },
  ops: { skin: '#bb8066', hair: '#302b29', outfit: '#667b50', trim: '#e5edd8', hairStyle: 'short', prop: 'headset' },
}

function PersonHair({ persona }: { persona: Persona }) {
  const cap = <path d="M23 28c-2-13 5-22 17-22 13 0 19 9 17 23l-7-5-8-2-8 2-7 6z" fill={persona.hair} />
  if (persona.hairStyle === 'long') return <><path d="M23 25c-2-10 6-19 17-19s20 9 17 20l-2 30-8-6V32l-7-8-9 6v20l-8 7z" fill={persona.hair} />{cap}</>
  if (persona.hairStyle === 'bob') return <><path d="M24 26c-2-12 4-20 16-20s19 9 17 22l-3 20-7-6V31l-8-8-9 6v15l-7 6z" fill={persona.hair} />{cap}</>
  if (persona.hairStyle === 'bun') return <><circle cx="53" cy="9" r="8" fill={persona.hair} />{cap}</>
  if (persona.hairStyle === 'wave') return <><circle cx="27" cy="17" r="8" fill={persona.hair} /><circle cx="38" cy="10" r="9" fill={persona.hair} /><circle cx="51" cy="15" r="8" fill={persona.hair} />{cap}</>
  return cap
}

function HandProp({ prop, trim }: { prop: Prop; trim: string }) {
  if (prop === 'laptop') return <g><path d="M50 55h17v13H50z" rx="2" fill="#39464a" /><path d="M47 68h23l-3 3H49z" fill="#95a9a8" /><path d="M52 57h13v9H52z" fill={trim} /></g>
  if (prop === 'clipboard') return <g><rect x="53" y="51" width="13" height="20" rx="2" fill="#f0e7d6" /><rect x="57" y="49" width="5" height="4" rx="1" fill="#7a6254" /><path d="M56 58h7M56 62h7M56 66h5" stroke="#b0a18b" strokeWidth="1.5" strokeLinecap="round" /></g>
  if (prop === 'swatches') return <g><rect x="52" y="54" width="16" height="15" rx="2" fill="#f4eee4" /><path d="M55 57h4v4h-4z" fill="#d67a66" /><path d="M61 57h4v4h-4z" fill="#6b9a92" /><path d="M55 63h4v4h-4z" fill="#e2bd70" /><path d="M61 63h4v4h-4z" fill="#7788ad" /></g>
  if (prop === 'book') return <g><path d="M52 54c4-2 7-1 9 1v15c-3-2-6-2-9 0z" fill="#e8eee0" /><path d="M61 55c2-2 5-3 8-1v16c-3-2-6-2-8 0z" fill={trim} /><path d="M61 55v15" stroke="#8aa29a" strokeWidth="1.2" /></g>
  return <g><rect x="53" y="52" width="13" height="18" rx="2" fill="#d8e3d5" /><path d="M56 57h7M56 61h7M56 65h5" stroke="#788b70" strokeWidth="1.4" strokeLinecap="round" /></g>
}

export default function AgentFigure({ agentId, className = '' }: { agentId: string; className?: string }) {
  const persona = personas[agentId] ?? personas.ceo

  return <svg className={className} viewBox="0 0 80 96" aria-hidden="true" focusable="false">
    <ellipse cx="40" cy="91" rx="21" ry="3" fill="#34433a" opacity=".13" />
    <path d="M31 65h9v20l-3 4h-9l4-6zM42 65h9l1 18 5 6h-10l-5-5z" fill="#454d4d" />
    <path d="M25 88h13l3 4H23zM47 88h12l4 4H49z" fill="#f1f0e8" />
    <path d="M27 42c3-5 9-8 14-8s12 3 15 8l2 25c-11 5-23 5-34 0z" fill={persona.outfit} />
    <path d="m29 45-9 14 5 4 11-12M52 45l9 11-5 5-10-10" fill="none" stroke={persona.outfit} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m29 44 8 5 3-5 4 5 9-6" fill="none" stroke={persona.trim} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M36 32h9v12l-5 4-5-4z" fill={persona.skin} />
    <path d="M25 25c0-11 6-18 16-18 11 0 17 7 16 18l-2 10c-2 8-8 13-14 13s-13-5-15-13z" fill={persona.skin} />
    <PersonHair persona={persona} />
    <path d="M31 29h3M46 29h3" stroke="#392c29" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="33" cy="32" r="1.2" fill="#302925" /><circle cx="47" cy="32" r="1.2" fill="#302925" />
    <path d="M38 35c1 1 2 1 3 0M36 40c2 2 6 2 8 0" fill="none" stroke="#9c604d" strokeWidth="1.3" strokeLinecap="round" />
    {persona.glasses && <g fill="none" stroke="#494743" strokeWidth="1.4"><rect x="28" y="29" width="9" height="7" rx="2" /><rect x="43" y="29" width="9" height="7" rx="2" /><path d="M37 32h6" /></g>}
    {persona.prop === 'headset' && <g fill="none" stroke="#d7c68d" strokeWidth="2"><path d="M23 28c0-13 6-21 17-21s18 8 18 21" /><path d="M23 26v8M58 26v8" /></g>}
    <path d="M60 59c2 0 3 1 4 3" fill="none" stroke={persona.skin} strokeWidth="4" strokeLinecap="round" />
    <HandProp prop={persona.prop} trim={persona.trim} />
    <path d="M21 61c-2 2-1 5 2 5M60 61c2 1 3 3 2 5" fill="none" stroke={persona.skin} strokeWidth="3.5" strokeLinecap="round" />
  </svg>
}
