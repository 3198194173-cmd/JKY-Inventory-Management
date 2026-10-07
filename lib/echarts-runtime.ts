import { init, use as registerCharts } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

registerCharts([LineChart,GridComponent,TooltipComponent,SVGRenderer]);
export { init };
export type { EChartsType } from 'echarts/core';
