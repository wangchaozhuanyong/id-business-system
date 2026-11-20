// Select an existing customer through the same name lookup an employee uses.
export async function chooseOrderCustomer(scope, customer) {
  await scope.locator('#commerce-customerName').fill(customer.name);
  await scope.locator(`[data-action="commerce-order-customer-choose"][data-id="${customer.id}"]`).click();
}
