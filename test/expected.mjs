// Expected "conflicts/missing" counts per Work Order with cards 010, 002, 003.
// If a rule change moves one of these numbers, the test fails before deploy.
export const expected = {
  'WO-1': '0/0', 'WO-2': '0/12', 'WO-3': '2/5', 'WO-4': '2/3', 'WO-5': '0/2', 'WO-6': '1/4', 'WO-7': '2/6',
  'WO-8': '0/5', 'WO-9': '0/4', 'WO-10': '0/7', 'WO-11': '0/7', 'WO-12': '0/3', 'WO-13': '3/6',
};
