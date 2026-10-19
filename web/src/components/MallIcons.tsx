import type { ReactNode } from "react";
import { ICON_STROKE, MALL_ICONS } from "../mall-icons";

interface Props {
  id: string;
  size?: number;
  className?: string;
}

/**
 * 商品图标：手绘技术线稿（见 ../../mall-icons.ts 的画法约定）。
 *
 * 描边用 currentColor，所以颜色由外层文字颜色决定：卡片里是墨色，
 * 买不起的商品压一层 opacity 就自动变淡，不需要另画一套。
 * 图标是纯装饰（名字就在旁边），所以 aria-hidden。
 */
export function ItemIcon({ id, size = 32, className }: Props) {
  const spec = MALL_ICONS[id];
  if (!spec) return null;

  const tints: ReactNode[] = [];
  (spec.t ?? []).forEach((d, i) => tints.push(<path key={`t${i}`} d={d} />));
  (spec.tc ?? []).forEach(([cx, cy, r], i) =>
    tints.push(<circle key={`tc${i}`} cx={cx} cy={cy} r={r} />),
  );

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {(spec.r ?? []).map(([x, y, w, h, rx], i) => (
        <rect key={`r${i}`} x={x} y={y} width={w} height={h} rx={rx} ry={rx} />
      ))}
      {(spec.e ?? []).map(([cx, cy, rx, ry, deg], i) => (
        <ellipse
          key={`e${i}`}
          cx={cx}
          cy={cy}
          rx={rx}
          ry={ry}
          transform={deg ? `rotate(${deg} ${cx} ${cy})` : undefined}
        />
      ))}
      {(spec.c ?? []).map(([cx, cy, r], i) => (
        <circle key={`c${i}`} cx={cx} cy={cy} r={r} />
      ))}
      {(spec.l ?? []).map(([x1, y1, x2, y2], i) => (
        <line key={`l${i}`} x1={x1} y1={y1} x2={x2} y2={y2} />
      ))}
      {(spec.p ?? []).map((d, i) => (
        <path key={`p${i}`} d={d} />
      ))}
      {tints.length > 0 && (
        <g fill="currentColor" fillOpacity={0.16} stroke="none">
          {tints}
        </g>
      )}
      {spec.f && spec.f.length > 0 && (
        <g fill="currentColor" stroke="none">
          {spec.f.map((d, i) => (
            <path key={`f${i}`} d={d} />
          ))}
        </g>
      )}
    </svg>
  );
}
