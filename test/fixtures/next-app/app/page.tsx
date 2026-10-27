export default function Page() {
  return (
    <form
      action={async (formData: FormData) => {
        'use server'
        await fetch('https://example.com/hook', { method: 'POST', body: formData })
      }}
    />
  )
}
