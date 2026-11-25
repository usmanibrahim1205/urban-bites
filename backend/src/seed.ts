import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './database.ts'

const menu = [
  ['burgers', 'Burgers', [
    ['classic-zinger', 'Classic Zinger', 550, 'Crispy fried chicken with lettuce and creamy sauce.'],
    ['double-zinger', 'Double Zinger', 750, 'Two crispy chicken fillets with lettuce and creamy sauce.'],
    ['grilled-chicken-burger', 'Grilled Chicken Burger', 650, 'Grilled chicken, lettuce and a tangy house sauce.'],
    ['beef-smash-burger', 'Beef Smash Burger', 850, 'Seared beef patty with cheese, pickles and onions.'],
  ]],
  ['pizza', 'Pizza', [
    ['chicken-fajita', 'Chicken Fajita', 1250, 'Spiced chicken with bell peppers, onions and mozzarella.'],
    ['chicken-tikka', 'Chicken Tikka', 1250, 'Chicken tikka, onions and mozzarella on a tomato base.'],
    ['pepperoni', 'Pepperoni', 1450, 'Pepperoni and melted mozzarella on a tomato base.'],
  ]],
  ['sides', 'Sides', [
    ['regular-fries', 'Regular Fries', 250, 'Golden-cut fries with a light sprinkle of salt.'],
    ['loaded-fries', 'Loaded Fries', 450, 'Crispy fries topped with cheese sauce and spring onions.'],
    ['chicken-nuggets', 'Chicken Nuggets', 400, 'Bite-sized breaded chicken with dipping sauce.'],
  ]],
  ['drinks', 'Drinks', [
    ['pepsi', 'Pepsi', 120, 'Chilled cola.'],
    ['7up', '7UP', 120, 'Chilled lemon-lime soda.'],
    ['mineral-water', 'Mineral Water', 80, 'Chilled bottled mineral water.'],
  ]],
  ['desserts', 'Desserts', [
    ['chocolate-brownie', 'Chocolate Brownie', 350, 'Rich cocoa brownie with a soft center.'],
    ['chocolate-sundae', 'Chocolate Sundae', 300, 'Vanilla ice cream drizzled with chocolate sauce.'],
  ]],
] as const

export function seedDemo(db: DatabaseSync, permanentIdentifiers?: ReadonlyMap<string, string>) {
  const insertTable = db.prepare(`
    INSERT INTO restaurant_tables (number, public_code) VALUES (?, ?)
    ON CONFLICT(number) DO NOTHING
  `)
  const insertCategory = db.prepare(`
    INSERT INTO menu_categories (slug, name, display_order) VALUES (?, ?, ?)
    ON CONFLICT(slug) DO NOTHING
  `)
  const insertItem = db.prepare(`
    INSERT INTO menu_items (category_id, slug, name, price_minor, description, display_order)
    VALUES ((SELECT id FROM menu_categories WHERE slug = ?), ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO NOTHING
  `)

  transaction(db, () => {
    const tableCode = db.prepare('SELECT public_code FROM restaurant_tables WHERE number = ?')
    for (let number = 1; number <= 10; number++) {
      const label = String(number).padStart(2, '0')
      const code = permanentIdentifiers?.get(label)
      if (permanentIdentifiers && (!code || !/^[0-9a-f]{32}$/.test(code))) {
        throw new Error('Hosted table identifiers are incomplete or invalid.')
      }
      insertTable.run(label, code ?? randomBytes(16).toString('hex'))
      if (code && tableCode.get(label)?.public_code !== code) {
        throw new Error('Hosted database table identifier does not match the manifest.')
      }
    }
    menu.forEach(([categorySlug, categoryName, items], categoryPosition) => {
      insertCategory.run(categorySlug, categoryName, categoryPosition)
      items.forEach(([slug, name, price, description], position) => {
        insertItem.run(categorySlug, slug, name, price * 100, description, position)
      })
    })
  })
}
