'use strict';

// Intentional relay restart requested via authenticated localhost API.
export const RELAY_RESTART_EXIT_CODE = 75;
// The runtime stopped on purpose and starting it again at once cannot help:
// its database needs a decision (adoptEarlierDatabase refused), or its data
// folder cannot be made (ensureDataDirs). The supervisors do not retry it, so
// its one line is said once; the code goes on to whatever started the relay.
// 78 is sysexits' EX_CONFIG.
export const RELAY_STOP_EXIT_CODE = 78;
