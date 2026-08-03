import { config } from './configuration/config.js';

// Storage classes are deliberately NOT re-exported here: the barrel is what
// main imports freely (config), so it must stay storage-free. Concrete
// backends are reachable only via deep imports, which the architecture
// fitness tests confine to the composition root (decision 56).
export { config };
