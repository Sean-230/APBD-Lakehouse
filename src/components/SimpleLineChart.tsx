"use client";

import React from "react";

interface Series {
  name: string;
  values: number[];
  color: string;
}

interface SimpleLineChartProps {
  labels: string[];
  series: Series[];
  unitSuffix?: string;
}

export function SimpleLineChart({
  labels,
  series,
  unitSuffix = "",
}: SimpleLineChartProps) {
  const width = 680;
  const height = 210;
  const padL = 74;
  const padR = 18;
  const padT = 14;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const allValues = series.flatMap((s) => s.values);
  const rawMax = Math.max(...allValues, 1);
  const mag = 10 ** Math.floor(Math.log10(rawMax));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= rawMax / 4) ?? 10) * mag;
  const maxVal = Math.ceil(rawMax / step) * step;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(t * maxVal));

  const xOf = (i: number) =>
    labels.length <= 1 ? padL + plotW / 2 : padL + (i / (labels.length - 1)) * plotW;
  const yOf = (v: number) => padT + plotH - (v / maxVal) * plotH;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-auto block"
      role="img"
      aria-label={series.map((s) => s.name).join(" vs ")}
    >
      {ticks.map((t) => {
        const y = yOf(t);
        return (
          <g key={t}>
            <line
              x1={padL}
              y1={y}
              x2={width - padR}
              y2={y}
              stroke="#eef0ef"
              strokeWidth="1"
            />
            <text
              x={padL - 8}
              y={y + 4}
              textAnchor="end"
              fill="#585c5a"
              fontSize="11"
              className="tabular-nums"
            >
              {t.toLocaleString("id-ID")}
              {unitSuffix}
            </text>
          </g>
        );
      })}

      {labels.map((lbl, i) => {
        const show =
          labels.length <= 6 || i % 2 === 0 || i === labels.length - 1;
        if (!show) return null;
        return (
          <text
            key={lbl}
            x={xOf(i)}
            y={height - 6}
            textAnchor="middle"
            fill="#585c5a"
            fontSize="11"
          >
            {lbl}
          </text>
        );
      })}

      {series.map((s) => {
        if (s.values.length === 1) {
          return (
            <circle
              key={s.name}
              cx={xOf(0)}
              cy={yOf(s.values[0])}
              r="4"
              fill={s.color}
            />
          );
        }
        const d = s.values
          .map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`)
          .join(" ");
        return (
          <path
            key={s.name}
            d={d}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}
