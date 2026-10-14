const base = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export const PlayIcon = (props) => (
  <svg {...base} {...props}><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" /></svg>
);
export const PauseIcon = (props) => (
  <svg {...base} {...props}><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" /></svg>
);
export const StopIcon = (props) => (
  <svg {...base} {...props}><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" /></svg>
);
export const DownloadIcon = (props) => (
  <svg {...base} {...props}><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" /></svg>
);
export const UpIcon = (props) => (
  <svg {...base} {...props}><path d="m6 14 6-6 6 6" /></svg>
);
export const DownIcon = (props) => (
  <svg {...base} {...props}><path d="m6 10 6 6 6-6" /></svg>
);
export const CloseIcon = (props) => (
  <svg {...base} {...props}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const PlusIcon = (props) => (
  <svg {...base} {...props}><path d="M12 5v14M5 12h14" /></svg>
);
export const GearIcon = (props) => (
  <svg {...base} {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);
export const PasteIcon = (props) => (
  <svg {...base} {...props}><rect x="8" y="3" width="8" height="4" rx="1" /><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" /></svg>
);
export const QuillIcon = (props) => (
  <svg {...base} {...props}><path d="M20 4c-6 0-11 4.5-12.5 11L6 20" /><path d="M20 4c0 5-3 9.5-9 11.5" /><path d="M8.5 13.5c2 .3 4 .2 6-.5" /></svg>
);
export const ImageIcon = (props) => (
  <svg {...base} {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5-5-9 9" /></svg>
);
