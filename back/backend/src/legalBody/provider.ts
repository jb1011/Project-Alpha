/**
 * The provider value of a customer's own company: an existing company its guardian declared,
 * rather than one filed through formation. It is what `companies.provider` holds for such a row.
 *
 * It lives in a module that imports nothing, so any layer can read it. The workflow layer must
 * never reach the API layer, not even through the imports of a module it imports, and the module
 * that creates a customer's company does import the API layer.
 */
export const CUSTOMER_PROVIDER = "customer";
