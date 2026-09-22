// Resolve only resources already accessible to the requesting account or public.
export function favoriteSummary(item, { userId, accountStore, store, routes }) {
  if (item.type === 'walk') {
    const own = accountStore.getWalk(userId, item.id);
    if (own && !own.snapshotError) return {...item, title:own.title, href:`/walk?id=${encodeURIComponent(own.id)}`};
    const route = routes.find(route => route.id === item.id);
    if (route) return {...item, title:route.title, href:`/walk?catalog=${encodeURIComponent(route.id)}`};
  }
  if (item.type === 'story') {
    const job = store.get(item.id);
    if (job && (job.kind ?? 'address') === 'address' && job.relevance !== 'irrelevant') return {...item, title:job.data?.story?.title || job.address, href:`/create?job=${encodeURIComponent(job.id)}`};
  }
  return {...item, title:'Материал недоступен', href:null};
}
