import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  addDays,
  addMonths,
  clampDate,
  daysInMonth,
  firstWeekday,
  formatLong,
  formatMonth,
  makeISODate,
  monthIndex,
  monthOf,
  todayUTC,
  type ISODate,
  type YearMonth,
} from '../lib/dates';
import { CalendarIcon, ChevronDown, ChevronLeft, ChevronRight } from './Icons';

interface Props {
  value: ISODate;
  min: ISODate;
  max: ISODate;
  onChange(date: ISODate): void;
}

export function DatePicker({ value, min, max, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const step = (days: number) => onChange(clampDate(addDays(value, days), min, max));

  return (
    <div className="datepicker" ref={rootRef}>
      <div className="date-bar material">
        <button
          type="button"
          className="date-bar__step"
          aria-label="Previous day"
          disabled={value <= min}
          onClick={() => step(-1)}
        >
          <ChevronLeft />
        </button>
        <span className="divider divider--vertical" />
        <button
          type="button"
          className="date-bar__value"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <CalendarIcon className="date-bar__icon" />
          <span>{formatLong(value)}</span>
        </button>
        <span className="divider divider--vertical" />
        <button
          type="button"
          className="date-bar__step"
          aria-label="Next day"
          disabled={value >= max}
          onClick={() => step(1)}
        >
          <ChevronRight />
        </button>
      </div>

      {open && (
        <CalendarPopover
          value={value}
          min={min}
          max={max}
          onSelect={(d) => {
            onChange(d);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface PopoverProps {
  value: ISODate;
  min: ISODate;
  max: ISODate;
  onSelect(date: ISODate): void;
}

function CalendarPopover({ value, min, max, onSelect }: PopoverProps) {
  const [view, setView] = useState<YearMonth>(() => monthOf(value));
  const [mode, setMode] = useState<'days' | 'years'>('days');

  const minMonth = monthOf(min);
  const maxMonth = monthOf(max);
  const canPrev = monthIndex(view) > monthIndex(minMonth);
  const canNext = monthIndex(view) < monthIndex(maxMonth);

  const pickYear = (year: number) => {
    const target = { year, month: view.month };
    const clamped =
      monthIndex(target) < monthIndex(minMonth)
        ? minMonth
        : monthIndex(target) > monthIndex(maxMonth)
          ? maxMonth
          : target;
    setView(clamped);
    setMode('days');
  };

  return (
    <div className="calendar material" role="dialog" aria-label="Choose a date">
      <div className="calendar__header">
        <button
          type="button"
          className="calendar__title"
          aria-expanded={mode === 'years'}
          onClick={() => setMode((m) => (m === 'days' ? 'years' : 'days'))}
        >
          {formatMonth(view)}
          <ChevronDown className={`calendar__title-chevron ${mode === 'years' ? 'is-open' : ''}`} />
        </button>
        {mode === 'days' && (
          <div className="calendar__nav">
            <button
              type="button"
              className="calendar__nav-button"
              aria-label="Previous month"
              disabled={!canPrev}
              onClick={() => setView((v) => addMonths(v, -1))}
            >
              <ChevronLeft />
            </button>
            <button
              type="button"
              className="calendar__nav-button"
              aria-label="Next month"
              disabled={!canNext}
              onClick={() => setView((v) => addMonths(v, 1))}
            >
              <ChevronRight />
            </button>
          </div>
        )}
      </div>

      {mode === 'days' ? (
        <DayGrid view={view} value={value} min={min} max={max} onSelect={onSelect} />
      ) : (
        <YearGrid
          fromYear={minMonth.year}
          toYear={maxMonth.year}
          selectedYear={view.year}
          onSelect={pickYear}
        />
      )}

      <div className="calendar__footer">
        <button
          type="button"
          className="text-button"
          disabled={value === max}
          onClick={() => onSelect(max)}
        >
          Latest
        </button>
      </div>
    </div>
  );
}

interface DayGridProps {
  view: YearMonth;
  value: ISODate;
  min: ISODate;
  max: ISODate;
  onSelect(date: ISODate): void;
}

function DayGrid({ view, value, min, max, onSelect }: DayGridProps) {
  const today = todayUTC();
  const lead = firstWeekday(view);
  const days = Array.from({ length: daysInMonth(view) }, (_, i) =>
    makeISODate(view.year, view.month, i + 1),
  );

  return (
    <div className="calendar__grid">
      {WEEKDAYS.map((w, i) => (
        <span key={i} className="calendar__weekday">
          {w}
        </span>
      ))}
      {Array.from({ length: lead }, (_, i) => (
        <span key={`lead-${i}`} />
      ))}
      {days.map((d, i) => {
        const disabled = d < min || d > max;
        const classes = ['calendar__day'];
        if (d === value) classes.push('is-selected');
        if (d === today) classes.push('is-today');
        return (
          <button
            key={d}
            type="button"
            className={classes.join(' ')}
            disabled={disabled}
            aria-pressed={d === value}
            aria-label={formatLong(d)}
            onClick={() => onSelect(d)}
          >
            {i + 1}
          </button>
        );
      })}
    </div>
  );
}

interface YearGridProps {
  fromYear: number;
  toYear: number;
  selectedYear: number;
  onSelect(year: number): void;
}

function YearGrid({ fromYear, toYear, selectedYear, onSelect }: YearGridProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  const years = Array.from({ length: toYear - fromYear + 1 }, (_, i) => fromYear + i);

  return (
    <div className="calendar__years">
      {years.map((y) => (
        <button
          key={y}
          ref={y === selectedYear ? selectedRef : undefined}
          type="button"
          className={`calendar__year ${y === selectedYear ? 'is-selected' : ''}`}
          onClick={() => onSelect(y)}
        >
          {y}
        </button>
      ))}
    </div>
  );
}
