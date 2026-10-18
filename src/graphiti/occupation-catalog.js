// Console catalog queries are on demand. Descriptions never enter task context.
export async function occupationCatalog(application, operation, input) {
  const { personalSpaceId, ...fields } = input;
  return application.personal.occupationCatalog(operation, {
    ...fields, personal_space_id: personalSpaceId
  });
}
