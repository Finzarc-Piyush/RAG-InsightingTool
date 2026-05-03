import {
  ChartSpec,
  DashboardNarrativeBlock,
  DashboardPivotSpec,
  DashboardTableSpec,
} from '@/shared/schema';

export type DashboardTile =
  | DashboardChartTile
  | DashboardInsightTile
  | DashboardTableTile
  | DashboardActionTile
  | DashboardNarrativeTile
  | DashboardPivotTile;

export interface DashboardNarrativeTile {
  kind: 'narrative';
  id: string;
  title: string;
  block: DashboardNarrativeBlock;
}

export interface DashboardChartTile {
  kind: 'chart';
  id: string;
  title: string;
  chart: ChartSpec;
  index: number;
  metadata?: {
    primaryMetricLabel?: string;
    primaryMetricValue?: string;
    lastUpdated?: Date;
  };
}

export interface DashboardInsightTile {
  kind: 'insight';
  id: string;
  title: string;
  narrative: string;
  confidence?: 'low' | 'medium' | 'high';
  relatedChartId?: string;
}

export interface DashboardTableTile {
  kind: 'table';
  id: string;
  title: string;
  table: DashboardTableSpec;
  index: number;
}

export interface DashboardActionTile {
  kind: 'action';
  id: string;
  title: string;
  recommendation: string;
  impactEstimate?: string;
  relatedChartId?: string;
}

export interface DashboardPivotTile {
  kind: 'pivot';
  id: string;
  title: string;
  pivot: DashboardPivotSpec;
  index: number;
}

export interface DashboardSection {
  id: string;
  title: string;
  description?: string;
  tiles: DashboardTile[];
}

