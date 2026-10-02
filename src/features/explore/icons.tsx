export type IconName = "map" | "list" | "locate" | "headphones" | "walk" | "bookmark" | "user" | "plus" | "close" | "arrow";
const paths: Record<IconName, React.ReactNode> = {
  map:<><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2z"/><path d="M9 3v16M15 5v16"/></>,
  list:<><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></>,
  locate:<><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></>,
  headphones:<><path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/></>,
  walk:<><circle cx="7" cy="5" r="2"/><circle cx="17" cy="19" r="2"/><path d="M7 7v4c0 4 10-2 10 3v3"/></>,
  bookmark:<path d="M6 3h12v18l-6-4-6 4z"/>,
  user:<><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  plus:<path d="M12 4v16M4 12h16"/>,
  close:<path d="m6 6 12 12M6 18 18 6"/>,
  arrow:<path d="M4 12h16m-6-6 6 6-6 6"/>,
};
export function ExploreIcon({name}: {name: IconName}) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
