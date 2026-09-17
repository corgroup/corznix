import { useState } from 'react';
import './SortableList.css';

// Drag-and-drop ordering for any list in the CMS, with the same result from
// the keyboard: focus a row's grip and press ArrowUp / ArrowDown. No library —
// native HTML5 drag events are enough for single-column lists, and keeping it
// here means every builder reorders the same way.
//
// renderItem(item, index, { handleProps, moveUp, moveDown, isFirst, isLast })
// must spread `handleProps` onto a <DragHandle>.
export function SortableList({ items, getKey, onReorder, renderItem, disabled = false, label, className = '' }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  const move = (from, to) => {
    if (disabled || to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);
  };

  const reset = () => { setDragIndex(null); setOverIndex(null); };

  return (
    <ul className={`sortable ${className}`.trim()} aria-label={label}>
      {items.map((item, i) => {
        const handleProps = {
          draggable: !disabled,
          onDragStart: (e) => {
            setDragIndex(i);
            e.dataTransfer.effectAllowed = 'move';
            // Firefox refuses to start a drag without data.
            e.dataTransfer.setData('text/plain', String(i));
          },
          onDragEnd: reset,
          onKeyDown: (e) => {
            if (e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1); }
          },
          'aria-label': `Move item ${i + 1} of ${items.length} — drag, or press the arrow keys`,
          'aria-disabled': disabled || undefined,
        };
        const rowClass = [
          'sortable__row',
          dragIndex === i ? 'sortable__row--dragging' : '',
          overIndex === i && dragIndex !== null && dragIndex !== i ? (dragIndex < i ? 'sortable__row--drop-after' : 'sortable__row--drop-before') : '',
        ].filter(Boolean).join(' ');
        return (
          <li
            key={getKey(item)}
            className={rowClass}
            onDragOver={(e) => {
              if (dragIndex === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (overIndex !== i) setOverIndex(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null) move(dragIndex, i);
              reset();
            }}
          >
            {renderItem(item, i, {
              handleProps,
              moveUp: () => move(i, i - 1),
              moveDown: () => move(i, i + 1),
              isFirst: i === 0,
              isLast: i === items.length - 1,
            })}
          </li>
        );
      })}
    </ul>
  );
}

export function DragHandle({ disabled, ...props }) {
  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      className={`drag-handle${disabled ? ' drag-handle--disabled' : ''}`}
      {...props}
    >
      <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true" fill="currentColor">
        <circle cx="3" cy="3" r="1.4" /><circle cx="9" cy="3" r="1.4" />
        <circle cx="3" cy="8" r="1.4" /><circle cx="9" cy="8" r="1.4" />
        <circle cx="3" cy="13" r="1.4" /><circle cx="9" cy="13" r="1.4" />
      </svg>
    </span>
  );
}

export default SortableList;
