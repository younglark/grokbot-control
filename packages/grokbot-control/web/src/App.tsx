import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowUpRight, Bot, Check, ChevronRight, CircleHelp, Command as CommandIcon, Gauge, LayoutDashboard, Monitor, Moon, RefreshCw, Search, ShieldCheck, Sun, Wifi, WifiOff } from "lucide-react";
import { StatusIcon, STATUS_META } from "@/components/status-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar, SidebarContent, SidebarHeader, SidebarFooter, SidebarProvider, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarGroup, SidebarGroupLabel, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { connectEvents, dashboardEpoch, refreshUsage, setFocus } from "@/lib/api";
import { BotDetail } from "@/components/bot-detail";
import { cn, CATEGORY_LABEL, formatBreakdownShare, formatTime, formatUsagePercent, whoamiSummary } from "@/lib/utils";
import type { ChannelConnectionView, DashboardBotDetail, DashboardBotRow, DashboardFrame, DashboardTimeline, FilterKey, SourceFreshnessView, UsageBreakdownView } from "@/types";

const filters: { key: FilterKey; label: string; subtitle: string }[] = [
 {key:"all",label:"全部 Bot",subtitle:"账号内可见的 Bot"},
 {key:"running",label:"运行中",subtitle:"正在处理中的 Bot"},
 {key:"waiting",label:"等待中",subtitle:"需要关注或正在等待"},
 {key:"unknown",label:"未知",subtitle:"尚无可用状态，不等于离线"},
];
function useWidth(){ const [w,set]=useState(window.innerWidth); useEffect(()=>{const fn=()=>set(window.innerWidth);window.addEventListener("resize",fn);return()=>window.removeEventListener("resize",fn)},[]);return w; }
function Status({row}:{row:DashboardBotRow}){const meta=STATUS_META[row.category];return <Badge data-status-surface="list" variant="secondary" title={meta.help} className={cn("gap-1.5 font-normal shrink-0",meta.badge)}><StatusIcon category={row.category}/>{meta.label}</Badge>}
export default function App(){
 const qc=useQueryClient(),width=useWidth();
 const paletteReturn=useRef<HTMLElement|null>(null);
 const openPalette=()=>{paletteReturn.current=document.activeElement as HTMLElement;setPalette(true)};
 const [navOpen,setNavOpen]=useState(width>=1280);
 useEffect(()=>setNavOpen(width>=1280),[width]);
 const [sse,setSse]=useState(false),[filter,setFilter]=useState<FilterKey>("all"),[search,setSearch]=useState(""),[selected,setSelected]=useState<string>(),[viewSession,setViewSession]=useState<string>(),[timelineVisible,setTimelineVisible]=useState(false),[epoch,setEpoch]=useState(dashboardEpoch()),[palette,setPalette]=useState(false),[usageOpen,setUsageOpen]=useState(false),[dark,setDark]=useState(document.documentElement.classList.contains("dark"));
 const {data:frame}=useQuery({queryKey:["dashboard-frame"],queryFn:async()=>qc.getQueryData<DashboardFrame>(["dashboard-frame"])??null,staleTime:Infinity});
 const {data:detail}=useQuery({queryKey:["bot-detail",selected],queryFn:async()=>selected?qc.getQueryData<DashboardBotDetail>(["bot-detail",selected])??null:null,staleTime:Infinity,enabled:!!selected});
 const resolvedSession=viewSession??detail?.session_view.current_session_id;
 const timelineKey=["bot-timeline",selected,resolvedSession] as const;
 const {data:timeline}=useQuery({queryKey:timelineKey,queryFn:async()=>selected?qc.getQueryData<DashboardTimeline>(timelineKey)??null:null,staleTime:Infinity,enabled:!!selected});
 useEffect(()=>connectEvents({
  onFrame:f=>qc.setQueryData(["dashboard-frame"],f),
  onDetail:d=>{
    // Shared Bot detail; this client applies its own session selection.
    qc.setQueryData(["bot-detail",d.agent_id],d);
  },
  onTimeline:tl=>{
    if(!tl.session_id) return;
    const key=["bot-timeline",tl.agent_id,tl.session_id];
    const currentSelected=qc.getQueryData<string>(["ui-selected-bot"]);
    const currentSession=qc.getQueryData<string>(["ui-view-session"]);
    if(currentSelected && tl.agent_id!==currentSelected) return;
    if(currentSession && tl.session_id!==currentSession) return;
    const existing=qc.getQueryData<DashboardTimeline>(key);
    if(existing?.generation_known && tl.generation_known && existing.generation!==tl.generation && tl.result!=="ok") return;
    qc.setQueryData(key,tl);
  },
  onHello:h=>setEpoch(h.connection_epoch),
  onStatus:setSse,
 }),[qc]);
 useEffect(()=>{setViewSession(undefined);setTimelineVisible(false)},[selected]);
 useEffect(()=>{qc.setQueryData(["ui-selected-bot"],selected);qc.setQueryData(["ui-view-session"],viewSession)},[qc,selected,viewSession]);
 useEffect(()=>{void setFocus({agent_id:selected,view_session_id:viewSession,timeline_visible:Boolean(selected&&timelineVisible),connection_epoch:epoch})},[selected,viewSession,timelineVisible,epoch]);
 useEffect(()=>{const fn=(e:KeyboardEvent)=>{if(width>=600&&(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();palette?setPalette(false):openPalette()}};window.addEventListener("keydown",fn);return()=>window.removeEventListener("keydown",fn)},[width,palette]);
 const toggle=()=>{const value=!dark;setDark(value);document.documentElement.classList.toggle("dark",value);localStorage.setItem("gbc-dashboard-theme",value?"dark":"light")};
 const refresh=useMutation({mutationFn:refreshUsage});
 const rows=useMemo(()=>(frame?.bots??[]).filter(r=>(filter==="all"||r.category===filter)&&[r.bot.name,r.bot.title,r.bot.agent_id,r.waiting_reason].some(v=>v?.toLowerCase().includes(search.toLowerCase()))),[frame,filter,search]);
 const row=frame?.bots.find(r=>r.bot.agent_id===selected), small=width<900, full=small&&!!row, computer=frame?.computer;
 const counts=frame?.counts??{total:0,running:0,waiting:0,unknown:0};
 const choose=(id:string)=>{setSelected(id);setPalette(false)};
 return <TooltipProvider><SidebarProvider open={navOpen} onOpenChange={setNavOpen} style={{"--sidebar-width-icon":"4rem"} as React.CSSProperties}>
  <Sidebar collapsible="icon" className="border-r">
   <SidebarHeader className="px-3 py-5 group-data-[collapsible=icon]:px-2"><div className="flex items-center gap-3 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0"><div data-testid="sidebar-brand-mark" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Activity className="size-4"/></div><div className="group-data-[collapsible=icon]:hidden"><p className="text-sm font-semibold tracking-tight">gbc dashboard</p><p className="text-xs text-muted-foreground">本地监控台</p></div></div></SidebarHeader>
   <SidebarContent><SidebarGroup><SidebarGroupLabel>工作空间</SidebarGroupLabel><SidebarMenu className="group-data-[collapsible=icon]:items-center"><SidebarMenuItem><SidebarMenuButton isActive tooltip="总览" onClick={()=>{setFilter("all");setSelected(undefined)}}><LayoutDashboard/><span>总览</span></SidebarMenuButton></SidebarMenuItem>{filters.slice(1).map(f=><SidebarMenuItem key={f.key}><SidebarMenuButton data-status-surface="sidebar" aria-label={STATUS_META[f.key as "running"|"waiting"|"unknown"].help} tooltip={STATUS_META[f.key as "running"|"waiting"|"unknown"].help} isActive={filter===f.key} onClick={()=>{setFilter(f.key);setSelected(undefined)}}><StatusIcon category={f.key as "running"|"waiting"|"unknown"}/><span>{f.label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup></SidebarContent>
   <SidebarFooter className="p-3 group-data-[collapsible=icon]:px-2"><Separator/><div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0"><ShieldCheck className="size-4 shrink-0"/><span className="group-data-[collapsible=icon]:hidden">只读 · 仅本机访问</span></div></SidebarFooter>
  </Sidebar>
  <SidebarInset className="min-w-0 bg-background">
   <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b bg-background/95 px-4 lg:px-8">
    <SidebarTrigger className="size-11"/><Separator orientation="vertical" className="h-5!"/><span className="text-sm font-medium">工作空间</span><span className="ml-auto hidden text-xs text-muted-foreground sm:inline" data-testid="login-summary">{whoamiSummary(frame?.auth.whoami)}</span>
    {width>=600&&<Button variant="ghost" size="icon" className="size-11" aria-label="搜索命令" onClick={openPalette}><Search className="size-4"/></Button>}
    <Button variant="ghost" size="icon" className="size-11" onClick={toggle} aria-label="切换主题" data-testid="theme-toggle">{dark?<Sun/>:<Moon/>}</Button>
   </header>
   <main className="mx-auto w-full max-w-[1600px] space-y-6 p-4 md:p-6 lg:p-8">
    <div className={cn("space-y-6",full&&"hidden")}><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="mb-1 flex items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">Bot 总览</h1><Badge variant="outline" className="font-normal">只读</Badge></div><p className="text-sm text-muted-foreground">关注当前活动，掌握需要你留意的状态。</p></div><div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="connection-chip">{sse?<Wifi className="size-3.5"/>:<WifiOff className="size-3.5"/>}SSE {sse?"已连接":"断开"}<span className="hidden sm:inline">· 上次成功刷新 {formatTime(frame?.connection.last_successful_upstream_at_ms)}</span>{frame?.connection.retrying&&<span data-testid="upstream-retry">· 正在重试{typeof frame.connection.retry_backoff_ms==="number"?`（${Math.round(frame.connection.retry_backoff_ms/1000)} 秒后）`:""}</span>}</div></div>
    {frame?.auth.banner&&<Notice testid="login-banner">{frame.auth.banner==="auth_refresh_failed"?"凭据刷新失败，已保留上一帧并暂停更新。":"尚未登录。"}请在终端运行 <code className="rounded bg-muted px-1 py-0.5">gbc auth login</code>，完成后刷新本页。</Notice>}
    {frame?.connection.upstream==="error"&&<Notice testid="upstream-error">上游读取失败，正在保留上次结果并等待重试。空列表不会与这次失败混在一起。</Notice>}
    {frame?.simulated&&<div className="flex items-center gap-2 text-xs text-muted-foreground"><Badge variant="secondary" className="text-[10px]">MOCK</Badge>仿真数据 · 非在线结果</div>}
    {frame?.list_truncated&&<Notice testid="truncated-banner">列表已截断（最多 1000 条），当前结果可能不完整。</Notice>}
    <section className="grid grid-cols-2 gap-3 xl:grid-cols-4 xl:gap-4" aria-label="统计">
     {filters.map(f=><Card key={f.key} className={cn("gap-0 py-0 shadow-none transition-colors",filter===f.key&&"border-primary/50 bg-primary/[.025]")}><button data-status-surface="stats" data-testid={`count-${f.key}`} onClick={()=>setFilter(f.key)} className="rounded-xl p-4 text-left focus-visible:outline-2 focus-visible:outline-primary lg:p-5"><span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">{f.label}{f.key!=="all"&&<StatusIcon category={f.key}/>}</span><div className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{f.key==="all"?counts.total:counts[f.key]}</div><p className="mt-2 hidden text-xs text-muted-foreground sm:block">{f.subtitle}</p></button></Card>)}
    </section>
    <div className="grid gap-4 sm:grid-cols-2">
     <Card className="gap-0 py-0 shadow-none"><CardContent className="flex items-center gap-3 p-4" data-testid="computer-chip" data-tone={computer?.live_verified?computer.tone:"unknown"}><div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Monitor className="size-5"/></div><div className="min-w-0 flex-1"><p className="text-sm font-medium">共享电脑 / 沙箱</p><p className="mt-1 text-xs text-muted-foreground"><span className="mr-1.5 inline-block size-1.5 rounded-full bg-muted-foreground" data-testid="computer-dot"/>{computer?.label??"未知"}</p></div><Help text="来自只读 GetSandBoxRunState（gbc computer state）。未经实时核验；未知或过期不会显示为绿色「运行中」，也不等同于离线。"/></CardContent></Card>
     <Card className="gap-0 py-0 shadow-none"><button onClick={()=>setUsageOpen(true)} className="flex w-full items-center gap-3 rounded-xl p-4 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-primary" data-testid="usage-chip"><div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Gauge className="size-5"/></div><div className="min-w-0 flex-1"><p className="text-sm font-medium">使用额度</p><p className="mt-1 text-xs text-muted-foreground">{frame?.usage?.cursor_plan_name??"额度摘要"}{frame?.usage?.usage_percent!==undefined?` · ${formatUsagePercent(frame.usage.usage_percent)}`:" · 查看详情"}</p></div><ChevronRight className="size-4 text-muted-foreground"/></button></Card>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
     <FreshnessPanel frame={frame}/>
     <ChannelsPanel frame={frame}/>
    </div>
    </div><div className={cn("grid items-start gap-5",width>=1280&&row&&"grid-cols-[minmax(0,1fr)_340px]")}>
     <Card className={cn("gap-0 overflow-hidden py-0 shadow-none",full&&"hidden")}>
      <CardHeader className="gap-4 border-b p-4 sm:p-5"><div className="flex items-center justify-between"><CardTitle className="text-base">Bot 列表 <span className="ml-1 text-xs font-normal text-muted-foreground">{rows.length}</span></CardTitle><Badge variant="outline" className="font-normal">{filters.find(f=>f.key===filter)?.label}</Badge></div><div className="relative"><Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"/><Input className="h-10 pl-9" placeholder="搜索名称、ID 或等待原因…" value={search} onChange={e=>setSearch(e.target.value)} data-testid={width<600?"phone-search":"bot-search"}/></div></CardHeader>
      <div className="max-h-[600px] overflow-y-auto" data-testid="bot-list">
       {!frame&&<div className="space-y-4 p-5">{[1,2,3].map(i=><Skeleton key={i} className="h-14 w-full"/>)}</div>}
       {frame&&rows.length===0&&<EmptyBots frame={frame}/>}
       {rows.map(r=><button key={r.bot.agent_id} onClick={()=>choose(r.bot.agent_id)} className={cn("flex min-h-[84px] w-full items-center gap-3 border-b px-4 py-4 text-left last:border-0 hover:bg-muted/50 focus-visible:relative focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary sm:px-5",selected===r.bot.agent_id&&"bg-accent")}><div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/50 text-sm font-semibold text-muted-foreground">{(r.bot.title||r.bot.name||"B").slice(0,1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{r.bot.title||r.bot.name||r.bot.agent_id}</div><div className="mt-1 truncate text-xs text-muted-foreground">{r.waiting_reason??r.bot.description??r.bot.agent_id}</div></div>{(r.status?.client?.unread_count??0)>0&&<Badge variant="secondary" className="font-normal shrink-0" data-testid="unread-badge">未读 {r.status?.client?.unread_count}</Badge>}<Status row={r}/><ChevronRight className="hidden size-4 shrink-0 text-muted-foreground sm:block"/></button>)}
      </div>
     </Card>
     {row&&width>=1280&&<BotDetail row={row} detail={detail??undefined} timeline={timeline??undefined} viewSession={resolvedSession} mobile={small} onViewSession={setViewSession} onTimelineVisible={setTimelineVisible}/>}
     {row&&small&&<div><Button type="button" variant="ghost" className="mb-3 h-11" data-testid="back-to-list" onClick={()=>setSelected(undefined)}><ArrowLeft/>返回列表</Button><BotDetail row={row} detail={detail??undefined} timeline={timeline??undefined} viewSession={resolvedSession} mobile={small} onViewSession={setViewSession} onTimelineVisible={setTimelineVisible}/></div>}
    </div>
    <p className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground"><ShieldCheck className="size-3.5"/>本地只读连接 · 不会中断远端 Bot</p>
   </main>
  </SidebarInset>
  <Sheet open={!!row&&width>=900&&width<1280} onOpenChange={v=>{if(!v)setSelected(undefined)}}><SheetContent className="overflow-y-auto sm:max-w-md"><SheetHeader><SheetTitle>Bot 详情</SheetTitle><SheetDescription>身份、任务与活动时间线</SheetDescription></SheetHeader>{row&&<div className="p-4"><BotDetail row={row} detail={detail??undefined} timeline={timeline??undefined} viewSession={resolvedSession} mobile={small} onViewSession={setViewSession} onTimelineVisible={setTimelineVisible}/></div>}</SheetContent></Sheet>
  <Sheet open={usageOpen} onOpenChange={setUsageOpen}><SheetContent className="overflow-y-auto"><SheetHeader><SheetTitle>使用额度</SheetTitle><SheetDescription>来自账号的只读额度摘要</SheetDescription></SheetHeader><div className="space-y-6 p-6"><div><p className="text-xs text-muted-foreground">当前计划</p><p className="mt-2 text-xl font-semibold">{frame?.usage?.cursor_plan_name??"暂不可用"}</p></div>{frame?.usage?.usage_percent!==undefined&&<div data-testid="usage-percent"><p className="text-3xl font-semibold tabular-nums">{formatUsagePercent(frame.usage.usage_percent)}</p><p className="mt-2 text-xs text-muted-foreground">已用百分比</p></div>}<p className="text-sm text-muted-foreground">{frame?.usage?.uses_pooled_enterprise_allowance?"企业共享额度":"个人账号额度"}</p>{frame?.usage?.included_limit_zero&&<p className="text-sm text-muted-foreground">没有非零包含额度上限，不绘制进度条。</p>}<Separator/><p className="text-xs leading-6 text-muted-foreground">不推算余额、币种或金额。包含额度为 0 时不绘制满额进度条。{frame?.usage_error?" 额度读取失败，保留上次结果。":""}</p>{frame?.usage?.next_reset_at&&<p className="text-sm">下次重置：{new Date(frame.usage.next_reset_at).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}（上海时间）</p>}{frame?.usage?.unified_billing_url&&<Button asChild variant="outline"><a href={frame.usage.unified_billing_url} target="_blank" rel="noreferrer">查看账单<ArrowUpRight/></a></Button>}<UsageBreakdownPanel breakdown={frame?.usage_breakdown} error={frame?.usage_breakdown_error}/><Button variant="outline" className="h-11" onClick={()=>refresh.mutate()} disabled={refresh.isPending}><RefreshCw className={cn("size-4",refresh.isPending&&"animate-spin")}/>刷新额度</Button></div></SheetContent></Sheet>
  <CommandDialog onCloseAutoFocus={e=>{e.preventDefault();paletteReturn.current?.focus()}} open={palette} onOpenChange={setPalette} title="搜索 Bot 或命令" description="输入名称搜索，使用方向键选择并按 Enter 确认。"><CommandInput placeholder="搜索 Bot 或命令…"/><CommandList data-testid="command-palette"><CommandEmpty>没有匹配项</CommandEmpty><CommandGroup heading="工作空间">{filters.map(f=><CommandItem key={f.key} onSelect={()=>{setFilter(f.key);setPalette(false)}}><LayoutDashboard/>{f.label}</CommandItem>)}</CommandGroup><CommandGroup heading="操作"><CommandItem onSelect={()=>{toggle();setPalette(false)}}><Moon/>切换主题</CommandItem><CommandItem onSelect={()=>{setUsageOpen(true);setPalette(false)}}><Gauge/>查看额度</CommandItem></CommandGroup><CommandGroup heading="Bot">{frame?.bots.map(r=><CommandItem key={r.bot.agent_id} value={`${r.bot.name} ${r.bot.title} ${r.bot.agent_id}`} onSelect={()=>choose(r.bot.agent_id)}><Bot/>{r.bot.title||r.bot.name}</CommandItem>)}</CommandGroup></CommandList></CommandDialog>
 </SidebarProvider></TooltipProvider>
}

function EmptyBots({frame}:{frame:DashboardFrame}){
  const bots=frame.connection.sources?.find(s=>s.id==="bots");
  if(frame.bots.length===0 && bots?.result==="error"){
    return <div className="flex flex-col items-center gap-2 px-5 py-16 text-center" data-testid="bot-list-error"><Bot className="mb-2 size-8 text-muted-foreground/50"/><p className="text-sm font-medium">Bot 列表读取失败</p><p className="text-xs text-muted-foreground">这不是空列表。{bots.stale?"已保留上次结果。":"尚无上次成功结果。"}</p></div>;
  }
  if(frame.bots.length===0){
    return <div className="flex flex-col items-center gap-2 px-5 py-16 text-center" data-testid="bot-list-empty"><Bot className="mb-2 size-8 text-muted-foreground/50"/><p className="text-sm font-medium">列表读取成功，当前没有 Bot</p><p className="text-xs text-muted-foreground">空列表与读取失败已区分。</p></div>;
  }
  return <div className="flex flex-col items-center gap-2 px-5 py-16 text-center"><Bot className="mb-2 size-8 text-muted-foreground/50"/><p className="text-sm font-medium">没有符合条件的 Bot</p><p className="text-xs text-muted-foreground">尝试其他关键词或切换筛选。</p></div>;
}
function FreshnessPanel({frame}:{frame?:DashboardFrame|null}){
  const sources=frame?.connection.sources??[];
  return <Card className="gap-0 py-0 shadow-none" data-testid="freshness-panel"><CardHeader className="p-4 pb-2"><CardTitle className="text-sm">数据新鲜度</CardTitle></CardHeader><CardContent className="space-y-2 p-4 pt-0 text-xs leading-5 text-muted-foreground"><p data-testid="last-successful-refresh">上次成功刷新：{formatTime(frame?.connection.last_successful_upstream_at_ms)}</p>{frame?.connection.retrying&&<p>有接口失败，正在重试{typeof frame.connection.retry_backoff_ms==="number"?`，约 ${Math.round(frame.connection.retry_backoff_ms/1000)} 秒后再次尝试`:""}。已保留上次成功结果（如有）。</p>}{sources.length===0&&<p>尚未拿到分源读取记录。</p>}<ul className="space-y-1.5">{sources.map((s)=><li key={s.id} data-testid={`freshness-${s.id}`} data-result={s.result} data-empty={s.empty?"true":undefined}>{sourceLine(s)}</li>)}</ul></CardContent></Card>;
}
function sourceLine(s:SourceFreshnessView){
  const result=s.result==="ok"?(s.empty?"读取成功，列表为空":"读取成功"):s.result==="error"?(s.stale?"读取失败，已保留上次结果":"读取失败"):"尚未读取";
  const when=s.last_successful_at_ms?` · ${formatTime(s.last_successful_at_ms)}`:"";
  const err=s.result==="error"&&s.error?` · ${s.error}`:"";
  return `${s.label}：${result}${when}${err}`;
}
function ChannelsPanel({frame}:{frame?:DashboardFrame|null}){
  const rows:ChannelConnectionView[]=frame?.channels??frame?.bots.flatMap((b)=>b.channels??[])??[];
  const botsSource=frame?.connection.sources?.find((s)=>s.id==="bots");
  return <Card className="gap-0 py-0 shadow-none" data-testid="channels-panel"><CardHeader className="p-4 pb-2"><CardTitle className="text-sm">渠道连接</CardTitle></CardHeader><CardContent className="space-y-2 p-4 pt-0 text-xs leading-5 text-muted-foreground"><p>只读展示 Slack / Teams 是否已接上，不含安装链接。</p>{botsSource?.result==="error"&&rows.length===0&&<p data-testid="channels-error">渠道状态随 Bot 列表读取；此次列表失败，不能当成「未连接」。</p>}{botsSource?.result==="ok"&&rows.length===0&&<p data-testid="channels-empty">列表读取成功，未报告 Slack 或 Teams 连接。</p>}{rows.length>0&&<ul className="space-y-1.5" data-testid="channels-list">{rows.map((c,i)=><li key={`${c.channel}-${c.agent_id}-${i}`} data-connected={c.connected?"true":"false"} data-state={c.state}>{channelBotName(frame,c.agent_id)} · {c.channel==="slack"?"Slack":"Teams"} {c.label}{c.workspace_or_tenant?` · ${c.workspace_or_tenant}`:""}{c.connected?"":""}</li>)}</ul>}</CardContent></Card>;
}
function channelBotName(frame:DashboardFrame|null|undefined, agentId:string){
  const bot=frame?.bots.find((r)=>r.bot.agent_id===agentId||r.bot.id===agentId)?.bot;
  return bot?.title||bot?.name||agentId;
}
function Help({text}:{text:string}){return <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-11 shrink-0 text-muted-foreground" aria-label="状态说明"><CircleHelp className="size-4"/></Button></TooltipTrigger><TooltipContent className="max-w-72 text-xs leading-5">{text}</TooltipContent></Tooltip>}
function Notice({children,testid}:{children:React.ReactNode;testid?:string}){return <div data-testid={testid} role="status" className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm leading-6">{children}</div>}
function UsageBreakdownPanel({breakdown,error}:{breakdown?:UsageBreakdownView;error?:string}){
 if(!breakdown&&!error) return null;
 const kind=breakdown?.kind??"empty";
 const label=kind==="billed_cents"?"按来源拆分（金额/币种未核实）":kind==="weekly_limit_ppm"?"按来源拆分（占周限额百分比）":kind==="billing_cycle_ppm"?"按来源拆分（占账期限额百分比）":kind==="empty"?"没有返回明细":"按来源拆分";
 return <div className="space-y-3" data-testid="usage-breakdown"><Separator/><p className="text-sm font-medium">用量明细</p><p className="text-xs text-muted-foreground">{label}</p>{error&&<p className="text-sm text-muted-foreground">明细读取失败，保留上次结果（如有）。{error}</p>}{breakdown?.by_source?.length? <ul className="space-y-1.5 text-sm">{breakdown.by_source.map((r,i)=><li key={i} className="flex justify-between gap-3"><span className="text-muted-foreground">{r.source??"来源"}</span><span className="tabular-nums">{formatBreakdownShare(r,kind)}</span></li>)}</ul> : kind==="empty"?<p className="text-sm text-muted-foreground">接口未返回 billed_cents / ppm 明细。</p>:null}{breakdown?.notes?.map((n,i)=><p key={i} className="text-xs leading-5 text-muted-foreground">{n}</p>)}</div>
}

