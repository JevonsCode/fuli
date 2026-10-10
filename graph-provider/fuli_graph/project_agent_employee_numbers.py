"""Space-wide FLA employee numbers, assigned in the identity write transaction.

Both identity creation paths take the space lock before touching an Agent.
The high-water mark survives archives and identity aliases; numbers are never
reused. Existing identities are backfilled in creation order on upgrade.
"""

EMPLOYEE_NUMBER_LOCK = '''
    SET space._employee_number_lock = true
    REMOVE space._employee_number_lock
    WITH space
'''

# Keep outer variables (notably ``agent``) intact. The subquery always returns
# one row, including when the space has no missing numbers.
ASSIGN_EMPLOYEE_NUMBERS = '''
    WITH space, agent
    CALL {
      WITH space
      MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(employee:FuliProjectAgent)
      WITH DISTINCT space, employee
      ORDER BY employee.created_at, employee.agent_id
      WITH space, collect(employee) AS employees
      WITH space, employees,
           [employee IN employees WHERE employee.employee_number IS NULL] AS missing,
           reduce(high = coalesce(space.fla_employee_sequence, 0), employee IN employees |
             CASE WHEN coalesce(employee.employee_number, 0) > high
               THEN employee.employee_number ELSE high END) AS high
      SET space.fla_employee_sequence = high + size(missing)
      FOREACH (index IN range(0, size(missing) - 1) |
        FOREACH (employee IN [missing[index]] |
          SET employee.employee_number = high + index + 1))
      FOREACH (employee IN [item IN employees WHERE item.employee_number_space_id IS NULL] |
        SET employee.employee_number_space_id = space.id)
      RETURN space.fla_employee_sequence AS employee_sequence
    }
'''


def employee_number_label(number: int | None) -> str | None:
    return f'{number:06d}' if number is not None else None
