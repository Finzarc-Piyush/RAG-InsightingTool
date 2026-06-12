import React, { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Resizable, ResizeCallback } from 're-resizable';
import Draggable, { DraggableData, DraggableEvent } from 'react-draggable';
import { GripVertical } from 'lucide-react';
import { logger } from "@/lib/logger";

interface ResizableTileProps {
  id?: string;
  children: ReactNode;
  defaultWidth?: number | string;
  defaultHeight?: number | string;
  minWidth?: number | string;
  minHeight?: number | string;
  className?: string;
  persist?: boolean;
  boundsSelector?: string; // CSS selector for draggable bounds
  axis?: 'both' | 'x' | 'y';
  lockFullWidth?: boolean; // when true, force tile to span full container width
  autoPosition?: { x: number; y: number } | null; // Auto-position from parent
  autoSize?: { width: number; height?: number } | null; // Auto-size from parent
  onPositionChange?: (position: { x: number; y: number }) => void; // Callback when position changes
  onSizeChange?: (size: { width: number; height: number }) => void; // Callback when size changes
}

export function ResizableTile({
  id,
  children,
  defaultWidth,
  defaultHeight,
  minWidth = 260,
  minHeight = 220,
  className = '',
  persist = true,
  boundsSelector = 'parent',
  axis = 'both',
  lockFullWidth = false,
  autoPosition = null,
  autoSize = null,
  onPositionChange,
  onSizeChange,
}: ResizableTileProps) {
  const storageKey = useMemo(() => (id ? `dashboard-tile-size:${id}` : ''), [id]);
  const initialWidth: number | string = typeof defaultWidth === 'undefined' ? 'auto' : defaultWidth;
  const initialHeight: number | string = typeof defaultHeight === 'undefined' ? (typeof minHeight === 'number' ? minHeight : 220) : defaultHeight;
  const [size, setSize] = useState<{ width: number | string; height: number | string }>({
    width: initialWidth,
    height: initialHeight,
  });
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [maxWidth, setMaxWidth] = useState<number | undefined>(undefined);
  const [boundsElement, setBoundsElement] = useState<HTMLElement | null>(null);
  const [dragBounds, setDragBounds] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const nodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!persist || !storageKey) return;
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.width && parsed.height) {
          let normalizedWidth: number | string = parsed.width;
          let normalizedHeight: number | string = parsed.height;
          if (typeof normalizedWidth === 'string') {
            const px = parseInt(normalizedWidth, 10);
            if (!isNaN(px)) {
              normalizedWidth = px;
            } else {
              normalizedWidth = typeof minWidth === 'number' ? minWidth : 260; // ignore percentages like '100%'
            }
          }
          if (typeof normalizedHeight === 'string') {
            const px = parseInt(normalizedHeight, 10);
            if (!isNaN(px)) {
              normalizedHeight = px;
            } else {
              normalizedHeight = typeof minHeight === 'number' ? minHeight : 220;
            }
          }
          setSize({ width: normalizedWidth, height: normalizedHeight });
          if (typeof parsed.posX === 'number' || typeof parsed.posY === 'number') {
            setPosition({ x: parsed.posX || 0, y: parsed.posY || 0 });
          }
        }
      } catch {}
    }
  }, [persist, storageKey, minWidth, minHeight]);

  // Initialize position to avoid overlapping if no saved position
  useEffect(() => {
    // Check if we have a saved position first
    if (persist && storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          // If position is saved, don't auto-position
          if (typeof parsed.posX === 'number' || typeof parsed.posY === 'number') {
            return;
          }
        } catch {}
      }
    }
    
    // Only auto-position if we're at default (0,0) and no saved position
    if (position.x !== 0 || position.y !== 0) return;
    
    const initializePosition = () => {
      if (!nodeRef.current) return;
      
      // Find all sibling tiles in the same container
      const chartGroup = nodeRef.current.closest('.chart-group');
      if (!chartGroup) return;
      
      const allTiles = Array.from(chartGroup.querySelectorAll('[data-tile-container] > div')) as HTMLElement[];
      
      // Find this tile's index by checking which container has this nodeRef
      let thisTileIndex = -1;
      const tileContainers = chartGroup.querySelectorAll('[data-tile-container]');
      tileContainers.forEach((container, idx) => {
        if (container.contains(nodeRef.current)) {
          thisTileIndex = idx;
        }
      });
      
      if (thisTileIndex < 0 || thisTileIndex === 0) return; // First tile stays at (0,0)
      
      // Calculate Y position based on previous tiles' heights + gaps
      // Use default heights: chart=330px, insight=150px
      const defaultHeights = [330, 150]; // Chart, Insight
      let calculatedY = 0;
      for (let i = 0; i < thisTileIndex; i++) {
        if (i < allTiles.length) {
          const prevTile = allTiles[i];
          if (prevTile) {
            // Try to get actual height, fallback to default height for this tile index
            const prevHeight = prevTile.offsetHeight || defaultHeights[i] || (typeof minHeight === 'number' ? minHeight : 220);
            calculatedY += prevHeight + 10; // 10px gap between stacked tiles
          } else if (i < defaultHeights.length) {
            // If tile doesn't exist yet, use default height
            calculatedY += defaultHeights[i] + 10;
          }
        }
      }
      
      // Only set position if we calculated a non-zero Y
      if (calculatedY > 0) {
        setPosition({ x: 0, y: calculatedY });
        // Save initial position
        if (persist && storageKey) {
          const saved = localStorage.getItem(storageKey);
          let base: any = { width: size.width, height: size.height };
          try { base = saved ? JSON.parse(saved) : base; } catch {}
          localStorage.setItem(storageKey, JSON.stringify({ ...base, posX: 0, posY: calculatedY }));
        }
      }
    };
    
    // Wait for DOM to be ready and localStorage to load
    const timeoutId = setTimeout(initializePosition, 200);
    
    return () => clearTimeout(timeoutId);
  }, [persist, storageKey, position, minHeight, size]);

  // Calculate bounds and max width based on parent container (chart-group)
  useEffect(() => {
    const updateBoundsAndMaxWidth = () => {
      if (!nodeRef.current) return;
      
      // Find the chart-group parent container
      let chartGroup: HTMLElement | null = null;
      
      if (boundsSelector && boundsSelector !== 'parent') {
        // If boundsSelector is a CSS selector, try to find the element
        try {
          chartGroup = document.querySelector(boundsSelector) as HTMLElement;
        } catch (e) {
          logger.warn('Invalid bounds selector:', boundsSelector);
        }
      }
      
      // Fallback to closest chart-group
      if (!chartGroup) {
        chartGroup = nodeRef.current.closest('.chart-group') as HTMLElement;
      }
      
      if (chartGroup && nodeRef.current) {
        const parentWidth = chartGroup.clientWidth;
        const parentHeight = chartGroup.clientHeight;
        
        // Calculate max width - ensure tiles never exceed parent container width
        // Account for container padding (p-4 = 16px on each side = 32px total)
        // Also account for inner container padding if it exists
        const containerPadding = 32;
        const innerPadding = 0; // Additional padding if needed
        const calculatedMaxWidth = Math.max(Number(minWidth), parentWidth - containerPadding - innerPadding);
        
        // If lockFullWidth, force min and max width to container width
        if (lockFullWidth) {
          setMaxWidth(calculatedMaxWidth);
          setSize(prev => ({ ...prev, width: calculatedMaxWidth }));
        } else {
          // Ensure maxWidth doesn't exceed parent container width
          setMaxWidth(Math.max(calculatedMaxWidth, Number(minWidth))); // Ensure maxWidth is at least minWidth
          
          // Also constrain current width if it exceeds the parent container
          const currentWidth = typeof size.width === 'number' ? size.width : (nodeRef.current?.offsetWidth || Number(minWidth));
          if (currentWidth > calculatedMaxWidth) {
            setSize(prev => ({ ...prev, width: Math.max(calculatedMaxWidth, Number(minWidth)) }));
          }
        }
        
        // Get the CollapsibleContent where tiles are positioned
        // Tiles are inside CollapsibleContent, so we need to use that as bounds
        // Radix UI adds data-radix-collapsible-content attribute to CollapsibleContent
        const collapsibleContent = chartGroup.querySelector('[data-radix-collapsible-content]') as HTMLElement;
        
        // Use CollapsibleContent as bounds if available, otherwise use chart-group
        // This ensures tiles can't be dragged outside the parent container boundaries
        const boundsContainer = collapsibleContent || chartGroup;
        setBoundsElement(boundsContainer);
        
        // Using the element directly as bounds - react-draggable will handle all calculations
        // This allows free movement in all directions (left, right, up, down) within the container
        // The bounds ensure tiles never exceed the parent container boundaries
      }
    };
    
    // Initial calculation with delay to ensure DOM is ready
    const timeoutId = setTimeout(updateBoundsAndMaxWidth, 50);
    
    // Watch for parent container size changes
    const observer = new ResizeObserver(() => {
      updateBoundsAndMaxWidth();
    });
    
    // Set up observer after a short delay to ensure refs are available
    const observerTimeoutId = setTimeout(() => {
      const chartGroup = nodeRef.current?.closest('.chart-group');
      if (chartGroup) {
        observer.observe(chartGroup);
        // Also observe CollapsibleContent if it exists
        const collapsibleContent = chartGroup.querySelector('[data-radix-collapsible-content]') as HTMLElement;
        if (collapsibleContent) {
          observer.observe(collapsibleContent);
        }
      }
    }, 100);
    
    // Also listen for window resize
    window.addEventListener('resize', updateBoundsAndMaxWidth);
    
    return () => {
      clearTimeout(timeoutId);
      clearTimeout(observerTimeoutId);
      observer.disconnect();
      window.removeEventListener('resize', updateBoundsAndMaxWidth);
    };
  }, [minWidth, minHeight, boundsSelector, size.width, size.height]);

  // If no default width supplied, initialize to parent width once mounted
  useEffect(() => {
    if (typeof defaultWidth === 'undefined' && nodeRef.current && (size.width === 'auto' || size.width === undefined)) {
      const parent = nodeRef.current.parentElement;
      if (parent) {
        const parentWidth = parent.clientWidth;
        if (parentWidth > 0) {
          setSize(prev => ({ ...prev, width: Math.max(parentWidth, Number(minWidth)) }));
        }
      }
    }
  }, [defaultWidth, minWidth]);

  const handleResize: ResizeCallback = () => {
    // Max width is enforced by the Resizable component's maxWidth prop
  };

  const handleResizeStop: ResizeCallback = (_e, dir, _ref, d) => {
    setSize(prev => {
      const newWidth = typeof prev.width === 'string' ? prev.width : Number(prev.width) + d.width;
      const newHeight = typeof prev.height === 'string' ? prev.height : Number(prev.height) + d.height;
      
      // Get the parent container to enforce width constraints
      let actualMaxWidth = maxWidth || Infinity;
      if (nodeRef.current) {
        const chartGroup = nodeRef.current.closest('.chart-group') as HTMLElement;
        if (chartGroup) {
          const collapsibleContent = chartGroup.querySelector('[data-radix-collapsible-content]') as HTMLElement;
          const boundsContainer = collapsibleContent || chartGroup;
          const containerPadding = 32; // Account for container padding
          const availableWidth = boundsContainer.clientWidth - containerPadding;
          actualMaxWidth = Math.min(actualMaxWidth, availableWidth);
        }
      }
      
      // Enforce min and max constraints
      const constrainedWidth = typeof newWidth === 'string' 
        ? newWidth 
        : Math.max(Number(minWidth), Math.min(newWidth, actualMaxWidth));
      const constrainedHeight = typeof newHeight === 'string'
        ? newHeight
        : Math.max(Number(minHeight), newHeight);
      
      const next = {
        width: constrainedWidth,
        height: constrainedHeight,
      };
      
      // Notify parent of size change
      if (onSizeChange) {
        const widthNum = typeof constrainedWidth === 'number' ? constrainedWidth : (typeof constrainedWidth === 'string' ? parseInt(constrainedWidth) : 0);
        const heightNum = typeof constrainedHeight === 'number' ? constrainedHeight : (typeof constrainedHeight === 'string' ? parseInt(constrainedHeight) : 0);
        onSizeChange({ width: widthNum, height: heightNum });
      }
      
      // persist size together with current position
      if (persist && storageKey) {
        const saved = localStorage.getItem(storageKey);
        let base: any = {};
        try { base = saved ? JSON.parse(saved) : {}; } catch {}
        localStorage.setItem(storageKey, JSON.stringify({ ...base, width: (next as any).width, height: (next as any).height, posX: position.x, posY: position.y }));
      }
      return next;
    });
  };

  const onDragStart = () => {
    setIsDragging(true);
    // Recalculate bounds when drag starts to ensure they're accurate
    if (nodeRef.current && boundsElement) {
      // Trigger bounds recalculation
      const updateBounds = () => {
        if (!nodeRef.current || !boundsElement) return;
        // The bounds element is already set, react-draggable will use it
        // But we can force a recalculation by checking if element still exists
        const chartGroup = nodeRef.current.closest('.chart-group') as HTMLElement;
        if (chartGroup) {
          const collapsibleContent = chartGroup.querySelector('[data-radix-collapsible-content]') as HTMLElement;
          const newBoundsContainer = collapsibleContent || chartGroup;
          if (newBoundsContainer !== boundsElement) {
            setBoundsElement(newBoundsContainer);
          }
        }
      };
      setTimeout(updateBounds, 0);
    }
  };
  // Handle auto-position updates (only when not dragging)
  useEffect(() => {
    if (autoPosition && !isDragging) {
      setPosition(autoPosition);
      if (onPositionChange) {
        onPositionChange(autoPosition);
      }
      // Save auto-position to localStorage
      if (persist && storageKey) {
        const saved = localStorage.getItem(storageKey);
        let base: any = {};
        try { base = saved ? JSON.parse(saved) : {}; } catch {}
        localStorage.setItem(storageKey, JSON.stringify({ ...base, posX: autoPosition.x, posY: autoPosition.y }));
      }
    }
  }, [autoPosition, isDragging, persist, storageKey, onPositionChange]);

  // Handle auto-size updates
  useEffect(() => {
    if (autoSize && !isDragging) {
      setSize(prev => ({
        width: autoSize.width,
        height: autoSize.height !== undefined ? autoSize.height : prev.height
      }));
      // Save auto-size to localStorage
      if (persist && storageKey) {
        const saved = localStorage.getItem(storageKey);
        let base: any = {};
        try { base = saved ? JSON.parse(saved) : {}; } catch {}
        localStorage.setItem(storageKey, JSON.stringify({ 
          ...base, 
          width: autoSize.width, 
          height: autoSize.height !== undefined ? autoSize.height : base.height 
        }));
      }
    }
  }, [autoSize, isDragging, persist, storageKey]);

  const onDrag = (_e: DraggableEvent, data: DraggableData) => {
    const newPosition = { x: data.x, y: data.y };
    setPosition(newPosition);
    if (onPositionChange) {
      onPositionChange(newPosition);
    }
  };
  // Commit a final position: update state, notify the parent, and persist.
  // Shared by mouse drag-stop and keyboard movement.
  const commitPosition = (newPosition: { x: number; y: number }) => {
    setPosition(newPosition);
    if (onPositionChange) {
      onPositionChange(newPosition);
    }
    if (persist && storageKey) {
      const saved = localStorage.getItem(storageKey);
      let base: any = {};
      try { base = saved ? JSON.parse(saved) : {}; } catch {}
      localStorage.setItem(storageKey, JSON.stringify({ ...base, posX: newPosition.x, posY: newPosition.y }));
    }
  };

  const onDragStop = (_e: DraggableEvent, data: DraggableData) => {
    setIsDragging(false);
    commitPosition({ x: data.x, y: data.y });
  };

  // WCAG 2.1.1 (keyboard) · the drag handle is focusable (role=button,
  // tabIndex 0); arrow keys move the tile in 16px steps (64px with Shift), so
  // tiles can be repositioned without a pointer.
  const onHandleKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    let dx = 0;
    let dy = 0;
    switch (e.key) {
      case 'ArrowLeft': dx = -step; break;
      case 'ArrowRight': dx = step; break;
      case 'ArrowUp': dy = -step; break;
      case 'ArrowDown': dy = step; break;
      default: return;
    }
    e.preventDefault();
    commitPosition({ x: Math.max(0, position.x + dx), y: Math.max(0, position.y + dy) });
  };

  // Use the bounds container element directly - react-draggable handles this better
  // This allows dragging in all directions (left, right, up, down) within the container
  const getBounds = (): HTMLElement | string => {
    if (boundsElement) {
      return boundsElement;
    }
    // Fallback to parent if boundsElement not set yet
    return 'parent';
  };

  return (
    <Draggable
      handle=".drag-handle"
      cancel='[class*="resizable-handle"]'
      bounds={getBounds() as any}
      axis={axis}
      position={position}
      onStart={onDragStart}
      onDrag={onDrag}
      onStop={onDragStop}
      nodeRef={nodeRef}
    >
      <div
        ref={nodeRef}
        style={{ position: 'absolute', zIndex: isDragging ? 50 : 'auto' }}
        role="group"
        aria-roledescription="Resizable, draggable dashboard tile"
      >
        <Resizable
          size={size}
          onResize={handleResize}
          onResizeStop={handleResizeStop}
          minWidth={lockFullWidth ? (maxWidth || 0) : minWidth}
          minHeight={minHeight}
          maxWidth={lockFullWidth ? (maxWidth || 0) : maxWidth}
          style={{ flex: 'none', boxSizing: 'border-box' }}
          enable={{
            top: true,
            right: !lockFullWidth,
            bottom: true,
            left: !lockFullWidth,
            topRight: !lockFullWidth,
            bottomRight: !lockFullWidth,
            bottomLeft: !lockFullWidth,
            topLeft: !lockFullWidth,
          }}
          handleStyles={{
            top: { cursor: 'ns-resize' },
            right: { cursor: lockFullWidth ? 'default' : 'ew-resize' },
            bottom: { cursor: 'ns-resize' },
            left: { cursor: lockFullWidth ? 'default' : 'ew-resize' },
            topRight: { cursor: lockFullWidth ? 'default' : 'ne-resize' },
            bottomRight: { cursor: lockFullWidth ? 'default' : 'se-resize' },
            bottomLeft: { cursor: lockFullWidth ? 'default' : 'sw-resize' },
            topLeft: { cursor: lockFullWidth ? 'default' : 'nw-resize' },
          }}
          className={`bg-card border border-border rounded-lg shadow-sm overflow-hidden ${className}`}
        >
          <div className="h-full w-full relative flex flex-col pt-4">
            <div
              className="drag-handle absolute left-0 top-0 w-full h-4 flex items-center gap-1 pl-2 text-muted-foreground cursor-grab active:cursor-grabbing bg-gradient-to-b from-muted/60 to-transparent z-10 flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              role="button"
              tabIndex={0}
              aria-label="Drag tile — focus and use arrow keys to move (hold Shift for larger steps)"
              aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
              onKeyDown={onHandleKeyDown}
            >
              <GripVertical className="h-4 w-4" />
              <span className="text-[10px]">Drag</span>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
            {children}
            </div>
          </div>
        </Resizable>
      </div>
    </Draggable>
  );
}


