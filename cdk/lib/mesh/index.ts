/**
 * An Envoy service mesh on ECS/EC2, with no control plane service.
 *
 * `Mesh` builds the shared infrastructure once; `MeshService` adds a service
 * to it. `MeshRef` is the handful of strings a service needs from the mesh,
 * which is what lets the same `MeshService` emit either a construct in this
 * app or a standalone CloudFormation template.
 */
export { Mesh, MeshProps } from './mesh';
export { MeshService, MeshServiceProps } from './service';
export { MeshRegistryEntry, MeshRegistryEntryProps } from './registry-entry';
export { MeshRef, MESH_REF_FIELDS, meshRefParameterName, meshRefFromSsm } from './ref';
export {
  ENVOY_LISTENER_PORT,
  ENVOY_ADMIN_PORT,
  DEFAULT_APP_PORT,
  CLOUDWATCH_STATSD_PORT,
  CLOUDWATCH_AGENT_IMAGE,
} from './constants';
