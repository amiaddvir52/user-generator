export type TeardownSignalBreakdown = {
  pHook: number;
  pName: number;
  pTrans: number;
  pOrigin: number;
};

export type TeardownCallObservation = {
  identifier: string;
  fromHook: boolean;
  fromImportPath?: string;
  calledIdentifiers: string[];
};

