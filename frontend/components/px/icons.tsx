// Icon set (Lucide). Kept under the old `PixelIcon` name so every screen keeps working;
// new code can import `Icon`.

import type { CSSProperties } from "react";
import {
  AppWindow,
  ArrowRight,
  ArrowUpRight,
  ArrowUpFromLine,
  Bot,
  ChevronRight,
  CircleCheck,
  CircleDollarSign,
  CircleX,
  Clock,
  Compass,
  Copy,
  CreditCard,
  Database,
  Dot,
  DoorOpen,
  Eye,
  Flag,
  Globe,
  HeartPulse,
  LayoutDashboard,
  Lock,
  Menu,
  MessageSquare,
  Play,
  Plus,
  Radio,
  Search,
  Server,
  Settings,
  Shapes,
  TriangleAlert,
  User,
  Workflow,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

const ICONS = {
  request: ArrowRight,
  lookup: Search,
  discover: Compass,
  observe: Eye,
  compile: Settings,
  verify: CircleCheck,
  publish: ArrowUpFromLine,
  execute: Play,
  bolt: Zap,
  coin: CircleDollarSign,
  heal: HeartPulse,
  broken: CircleX,
  sandbox: Server,
  pattern: Shapes,
  message: MessageSquare,
  dot: Dot,
  door: DoorOpen,
  agent: Bot,
  database: Database,
  globe: Globe,
  tool: Wrench,
  warn: TriangleAlert,
  user: User,
  lock: Lock,
  copy: Copy,
  clock: Clock,
  plus: Plus,
  chevron: ChevronRight,
  graph: Workflow,
  race: Flag,
  site: AppWindow,
  overview: LayoutDashboard,
  live: Radio,
  card: CreditCard,
  external: ArrowUpRight,
  menu: Menu,
  close: X,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  className,
  title,
  strokeWidth = 1.75,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  const Cmp = ICONS[name];
  return (
    <Cmp
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={style}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      role={title ? "img" : undefined}
    />
  );
}

/** @deprecated use Icon */
export const PixelIcon = Icon;
