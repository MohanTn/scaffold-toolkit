namespace StoreMediaApi.V2.Infrastructure.Repositories;

public interface IRepository<T>
    where T : class
{
    Task<T?> GetByIdAsync(long id, CancellationToken cancellationToken = default);

    Task<List<T>> GetAllAsync(CancellationToken cancellationToken = default);

    Task AddAsync(T entity, CancellationToken cancellationToken = default);

    void Update(T entity);

    void Remove(T entity);
}
