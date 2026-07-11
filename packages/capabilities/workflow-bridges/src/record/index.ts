export {
  RECORD_SUBMITTED_ENVELOPE_KEYS,
  RECORD_SUBMITTED_EVENT_TYPE,
  submittedRecordEventToWorkflowInput,
} from './adapter.js';
export {
  CrossTenantRecordEventError,
  createWorkflowIngressRecordSubmittedSink,
  WorkflowIngressRecordSubmittedSink,
  type WorkflowIngressRecordSubmittedSinkConfig,
} from './sink.js';
